// 给应用图标加 macOS 规格的圆角透明遮罩（squircle 近似：半径 = 边长 × 22.37%）。
// 用法: osascript -l JavaScript mask-icon.jxa.js <输入png> <输出png>
ObjC.import("Cocoa");

function run(argv) {
  const [src, dst] = argv;
  if (!src || !dst) {
    console.error("用法: mask-icon.jxa.js <in.png> <out.png>");
    return 1;
  }
  const img = $.NSImage.alloc.initWithContentsOfFile(src);
  if (img.isNil()) {
    console.error("无法读取图片: " + src);
    return 1;
  }
  const reps = img.representations;
  const src0 = reps.objectAtIndex(0);
  const w = src0.pixelsWide;
  const h = src0.pixelsHigh;

  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, w, h, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0
  );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);

  const rect = $.NSMakeRect(0, 0, w, h);
  const r = w * 0.2237;
  const path = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, r, r);
  path.addClip;
  img.drawInRect(rect);

  $.NSGraphicsContext.restoreGraphicsState;

  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  const ok = data.writeToFileAtomically(dst, true);
  if (!ok) {
    console.error("写入失败: " + dst);
    return 1;
  }
  // 自检：四角 alpha 应为 0，中心应不透明
  const out = $.NSBitmapImageRep.imageRepWithData(data);
  const corner = out.colorAtXY(2, 2);
  const center = out.colorAtXY(Math.floor(w / 2), Math.floor(h / 2));
  console.log(`${w}x${h} 角alpha=${corner.alphaComponent.toFixed(3)} 中心alpha=${center.alphaComponent.toFixed(3)}`);
  return corner.alphaComponent === 0 && center.alphaComponent > 0.9 ? 0 : 1;
}
