// 把图标内容"撑满"画布：裁到实际图案边界 → 向内缩掉抗锯齿混合带 → 等比放大铺满 → 套 macOS 圆角遮罩。
// 背景：AI 生成的图常把 squircle 画小、外圈留白；而按"第一个非白像素"裁会正好切进
// 图案边缘的白+深色混合带，缩放后残留成一圈细白环（直边上遮罩不裁切，Dock 小尺寸可见）。
// 用法: osascript -l JavaScript fit-icon.jxa.js <in.png> <out.png> [inset比例，默认 0.015]
ObjC.import("Cocoa");

function run(argv) {
  const [src, dst, insetArg] = argv;
  const INSET = Number(insetArg ?? 0.015);
  const img = $.NSImage.alloc.initWithContentsOfFile(src);
  if (img.isNil()) {
    console.error("无法读取: " + src);
    return 1;
  }
  const rep0 = img.representations.objectAtIndex(0);
  const W = rep0.pixelsWide,
    H = rep0.pixelsHigh;

  // 判定"图案像素"：非透明 且 非近白
  const isArt = (x, y) => {
    const c = rep0.colorAtXY(x, y);
    if (c.alphaComponent < 0.5) return false;
    const r = c.redComponent * 255,
      g = c.greenComponent * 255,
      b = c.blueComponent * 255;
    return !(r > 235 && g > 235 && b > 235);
  };

  const midY = H >> 1,
    midX = W >> 1;
  let minX = 0;
  while (minX < midX && !isArt(minX, midY)) minX++;
  let maxX = W - 1;
  while (maxX > midX && !isArt(maxX, midY)) maxX--;
  let minY = 0;
  while (minY < midY && !isArt(midX, minY)) minY++;
  let maxY = H - 1;
  while (maxY > midY && !isArt(midX, maxY)) maxY--;
  const cw = maxX - minX + 1,
    ch = maxY - minY + 1;
  if (cw <= 0 || ch <= 0) {
    console.error("未找到图案边界");
    return 1;
  }
  console.log(
    `图案边界 x[${minX},${maxX}] y[${minY},${maxY}] = ${cw}x${ch} / 画布 ${W}x${H}`,
  );

  // 目标：正方形铺满画布（取宽高较大者，居中裁方形，避免拉伸变形）。
  // 再向内缩 shrink px：裁到"第一个非白像素"会正好切进图案边缘的白色混合带，
  // 缩放后残留成一圈细白环（直边上遮罩不裁切，Dock 小尺寸下可见）。
  const side0 = Math.max(cw, ch);
  const shrink = Math.round(side0 * INSET);
  const side = side0 - shrink * 2;
  let sx = minX - (((side0 - cw) / 2) | 0) + shrink;
  let sy = minY - (((side0 - ch) / 2) | 0) + shrink;
  sx = Math.max(0, Math.min(sx, W - side));
  sy = Math.max(0, Math.min(sy, H - side));
  console.log(`内缩 ${shrink}px → 裁切 ${side}x${side}（原图案 ${cw}x${ch}）`);
  // NSImage 绘制坐标是左下原点，bitmap 是左上原点 → 转换 y
  const srcRect = $.NSMakeRect(sx, H - (sy + side), side, side);

  const out =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      W,
      H,
      8,
      4,
      true,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0,
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(out);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);

  const full = $.NSMakeRect(0, 0, W, H);
  const r = W * 0.2237; // macOS squircle 近似半径
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(full, r, r).addClip;
  img.drawInRectFromRectOperationFraction(
    full,
    srcRect,
    $.NSCompositeSourceOver,
    1.0,
  );

  $.NSGraphicsContext.restoreGraphicsState;
  const data = out.representationUsingTypeProperties(
    $.NSBitmapImageFileTypePNG,
    $.NSDictionary.dictionary,
  );
  if (!data.writeToFileAtomically(dst, true)) {
    console.error("写入失败: " + dst);
    return 1;
  }

  const chk = $.NSBitmapImageRep.imageRepWithData(data);
  const mid = W >> 1;
  const pts = {
    上边中点: [mid, 1],
    下边中点: [mid, H - 2],
    左边中点: [1, mid],
    右边中点: [W - 2, mid],
    角: [2, 2],
  };
  let bad = 0;
  for (const k in pts) {
    const c = chk.colorAtXY(pts[k][0], pts[k][1]);
    const r = c.redComponent * 255,
      g = c.greenComponent * 255,
      b = c.blueComponent * 255;
    const whiteish = c.alphaComponent > 0.5 && r > 225 && g > 225 && b > 225;
    if (k === "角" ? c.alphaComponent !== 0 : whiteish) bad++;
    console.log(
      `  ${k}: RGB=${r | 0},${g | 0},${b | 0} a=${c.alphaComponent.toFixed(2)}${whiteish ? " ← 白!" : ""}`,
    );
  }
  return bad === 0 ? 0 : 1;
}
