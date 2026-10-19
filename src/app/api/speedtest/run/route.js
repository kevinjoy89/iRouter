import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 纯 Web 环境下流式测速 SSE 降级网关路由
 *
 * @author iRouter
 * @since 2026-10-16
 */

/**
 * 线性插值计算百分位数
 *
 * @param {Array<number>} sortedVals 已排序的数组
 * @param {number} pct 百分比（0.0 ~ 1.0）
 * @return {number} 计算结果
 */
function calcPercentile(sortedVals, pct) {
  if (!sortedVals || sortedVals.length === 0) return 0;
  if (sortedVals.length === 1) return sortedVals[0];
  const rank = pct * (sortedVals.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, sortedVals.length - 1);
  const weight = rank - lower;
  return sortedVals[lower] * (1 - weight) + sortedVals[upper] * weight;
}

/**
 * 降级测速运行处理函数（通过 SSE 流向客户端推送进度）
 *
 * @param {Request} request HTTP 请求对象
 * @return {Promise<Response>} SSE 流式响应
 */
export async function POST(request) {
  try {
    const config = await request.json();
    const {
      sessionId = crypto.randomUUID(),
      targetUrl,
      protocol = "openai",
      apiKey,
      model,
      prompt,
      maxTokens,
      temperature,
      customHeaders,
    } = config;

    if (!targetUrl || !model || !prompt) {
      return NextResponse.json({ error: "缺少 targetUrl、model 或 prompt 必填参数" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const startTime = performance.now();

    // 组装请求头
    const headers = { "Content-Type": "application/json", ...(customHeaders || {}) };
    if (apiKey) {
      if (protocol === "anthropic") {
        headers["x-api-key"] = apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${apiKey.trim()}`;
      }
    }

    // 组装请求体
    let payload = {};
    if (protocol === "anthropic") {
      payload = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        max_tokens: maxTokens || 1024,
        ...(temperature !== undefined ? { temperature } : {}),
      };
    } else if (protocol === "responses") {
      payload = {
        model,
        input: prompt,
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
      };
    } else {
      payload = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };
    }

    const upstreamResponse = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return NextResponse.json(
        { error: `上游接口返回错误 (${upstreamResponse.status}): ${errText}` },
        { status: upstreamResponse.status }
      );
    }

    // 创建 SSE 流
    const stream = new ReadableStream({
      async start(controller) {
        /**
         * 发送 SSE 进度数据帧
         *
         * @param {Object} data 进度数据
         */
        const sendProgress = (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        sendProgress({
          sessionId,
          step: "streaming",
          ttftMs: null,
          elapsedMs: 0,
          currentTokenCount: 0,
          currentSpeed: 0,
        });

        const reader = upstreamResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let ttftTime = null;
        let lastChunkTime = null;
        const intervals = [];
        let accumulatedChars = 0;
        let officialUsageTokens = null;
        const curvePoints = [];

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const now = performance.now();
            if (lastChunkTime !== null) {
              intervals.push(now - lastChunkTime);
            }
            lastChunkTime = now;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line || !line.startsWith("data:")) continue;

              const dataStr = line.slice(5).trim();
              if (dataStr === "[DONE]") break;

              let textDelta = null;
              try {
                const parsed = JSON.parse(dataStr);
                if (protocol === "anthropic") {
                  if (parsed.type === "content_block_delta") {
                    textDelta = parsed.delta?.text;
                  } else if (parsed.type === "message_delta" && parsed.usage?.output_tokens) {
                    officialUsageTokens = parsed.usage.output_tokens;
                  }
                } else if (protocol === "responses") {
                  textDelta = parsed.delta || parsed.text;
                  if (parsed.response?.usage?.output_tokens) {
                    officialUsageTokens = parsed.response.usage.output_tokens;
                  }
                } else {
                  textDelta =
                    parsed.choices?.[0]?.delta?.content ??
                    parsed.choices?.[0]?.delta?.reasoning_content ??
                    parsed.choices?.[0]?.delta?.reasoning ??
                    null;
                  if (parsed.usage?.completion_tokens) {
                    officialUsageTokens = parsed.usage.completion_tokens;
                  }
                }
              } catch {
                // 忽略非 JSON 行
              }

              if (textDelta) {
                if (ttftTime === null) {
                  ttftTime = now;
                }
                accumulatedChars += textDelta.length;
                const currentTokens = officialUsageTokens ?? Math.max(1, Math.floor(accumulatedChars / 4));
                const elapsedMs = now - startTime;
                const steadySec = Math.max(1, elapsedMs - (ttftTime - startTime)) / 1000;
                const currentSpeed = Number((currentTokens / steadySec).toFixed(2));

                if (curvePoints.length < 64 && currentTokens % 4 === 0) {
                  curvePoints.push({
                    tokenIndex: currentTokens,
                    elapsedMs: Number(elapsedMs.toFixed(1)),
                    speed: currentSpeed,
                  });
                }

                sendProgress({
                  sessionId,
                  step: "streaming",
                  ttftMs: Number((ttftTime - startTime).toFixed(1)),
                  elapsedMs: Number(elapsedMs.toFixed(1)),
                  currentTokenCount: currentTokens,
                  currentSpeed,
                  latestCurvePoint: curvePoints[curvePoints.length - 1],
                });
              }
            }
          }

          const endTime = performance.now();
          const totalDurationMs = Number((endTime - startTime).toFixed(1));
          const ttftMs = ttftTime !== null ? Number((ttftTime - startTime).toFixed(1)) : totalDurationMs;
          const generationDurationMs = Number(Math.max(0, totalDurationMs - ttftMs).toFixed(1));

          const finalTokens = officialUsageTokens ?? Math.max(1, Math.floor(accumulatedChars / 4));
          const steadySpeed = Number((finalTokens / (Math.max(1, generationDurationMs) / 1000)).toFixed(2));
          const avgSpeed = Number((finalTokens / (Math.max(1, totalDurationMs) / 1000)).toFixed(2));

          intervals.sort((a, b) => a - b);
          const p50 = Number(calcPercentile(intervals, 0.5).toFixed(1));
          const p95 = Number(calcPercentile(intervals, 0.95).toFixed(1));
          const p99 = Number(calcPercentile(intervals, 0.99).toFixed(1));
          const jitterRatio = p50 > 0.0001 ? Number((p95 / p50).toFixed(2)) : null;

          if (curvePoints.length === 0 || curvePoints[curvePoints.length - 1].tokenIndex !== finalTokens) {
            curvePoints.push({
              tokenIndex: finalTokens,
              elapsedMs: totalDurationMs,
              speed: avgSpeed,
            });
          }

          const finalResult = {
            sessionId,
            model,
            success: true,
            ttftMs,
            totalDurationMs,
            generationDurationMs,
            steadySpeed,
            avgSpeed,
            outputTokens: finalTokens,
            tokensEstimated: officialUsageTokens === null,
            chunkMetrics: {
              p50Ms: p50,
              p95Ms: p95,
              p99Ms: p99,
              jitterRatio,
            },
            curvePoints,
          };

          sendProgress({
            sessionId,
            step: "completed",
            ttftMs,
            elapsedMs: totalDurationMs,
            currentTokenCount: finalTokens,
            currentSpeed: steadySpeed,
            result: finalResult,
          });
        } catch (streamErr) {
          sendProgress({
            sessionId,
            step: "failed",
            error: streamErr.message,
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    console.error("SSE 降级测速异常:", err);
    return NextResponse.json({ error: err.message || "执行测速失败" }, { status: 500 });
  }
}
