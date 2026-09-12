// 测试用凭据常量。
//
// 为什么用 base64 而不是字面量：`sk-` 形状的字符串会在多处中间层被替换为
// `[REDACTED:...]` 占位符（本仓 DLP 自身、日志脱敏、以及编辑/传输链路），
// 写在源码里会静默变成另一个值——测试于是断言一个从未存在过的 token。
// 用 base64 构造，生效值在任何链路上都保持稳定。
//
// 该值形状上会被 ai_tokens 规则命中（sk- 前缀 + 24 位高熵 + 过 min_entropy 2.8），
// 且不会被 allowlist（your_key/example/placeholder）放过。

/** OpenAI 风格的高熵 token，形状上必然被 ai_tokens 命中 */
export const AI_TOKEN = Buffer.from(
 "c2stcHJvai1BYjN4SzltUTd6UjJ0WTV3TDhuUDR2QzZiRDFmRzBoSg==",
 "base64",
).toString("utf8");

/** 同值但 base64 编码后的形式，用于验证编码递归检测 */
export const AI_TOKEN_B64 = Buffer.from(AI_TOKEN, "utf8").toString("base64");

/**
 * 不透明凭据：形状上**不匹配任何内置规则**（无 sk-/AKIA/ghp_ 等前缀、无 eyJ、
 * 无 api_key= 之类关键词、非纯数字），故只能被「已知密钥精确匹配」抓到。
 * 用于验证 dlpKnownSecrets=false 时确实不按已知密钥拦截。
 * 同样用 base64 构造（见文件头说明）。
 */
export const OPAQUE_SECRET = Buffer.from(
 "dmVuZG9yY3JlZC1BN2ZLMm1ROXhaNHRSNndQ",
 "base64",
).toString("utf8");
