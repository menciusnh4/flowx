const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  // 动态导入png-to-ico (ES Module)
  const pngToIco = (await import('png-to-ico')).default;
  
  const BUILD_DIR = path.join(__dirname, '..', 'build');
  const SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo2.png');

  console.log('=== FlowX 图标生成工具 ===\n');

  if (!fs.existsSync(SOURCE)) {
    console.error('❌ 源文件不存在:', SOURCE);
    process.exit(1);
  }

  const metadata = await sharp(SOURCE).metadata();
  console.log('📷 源图片:', metadata.width, 'x', metadata.height);

  // 使用完整图片（正方形）
  const size = Math.min(metadata.width || 1024, metadata.height || 1024);
  const left = Math.floor(((metadata.width || 1024) - size) / 2);
  const top = Math.floor(((metadata.height || 1024) - size) / 2);

  // ========== 按照 macOS 官方设计规范 (Apple Icon Design Guidelines) ==========
  // macOS Dock 标准图标规范：
  // 1024x1024 画布，图标主体为 824x824 居中（四周留出约 100px 透明边距），圆角半径约 185px
  console.log('\n🔨 生成符合 macOS 规范的 icon.png (1024x1024，主体824x824)...');
  const targetSize = 824;
  const margin = Math.floor((1024 - targetSize) / 2); // 100px 边距
  const cornerRadius = 185;

  const roundedMask = Buffer.from(
    `<svg><rect x="0" y="0" width="${targetSize}" height="${targetSize}" rx="${cornerRadius}" ry="${cornerRadius}" /></svg>`
  );

  const resizedLogoBuf = await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(targetSize, targetSize, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .composite([{
      input: roundedMask,
      blend: 'dest-in'
    }])
    .toBuffer();

  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{
      input: resizedLogoBuf,
      top: margin,
      left: margin
    }])
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.png'));
  console.log('  ✅ icon.png 已生成 (符合 macOS 视觉比例规范)');

  // 2. 生成各尺寸PNG用于构建icon.ico
  console.log('\n🔨 生成各尺寸PNG用于icon.ico...');
  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
  const tmpPngPaths = [];
  
  for (const s of ICO_SIZES) {
    const tmpPath = path.join(BUILD_DIR, `_tmp_ico_${s}.png`);
    await sharp(SOURCE)
      .extract({ left, top, width: size, height: size })
      .resize(s, s, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(tmpPath);
    tmpPngPaths.push(tmpPath);
    console.log(`  ✅ ${s}x${s}`);
  }

  // 3. 生成 icon.ico (Windows预构建图标，electron-builder会直接使用)
  console.log('\n🔨 生成 icon.ico...');
  try {
    const icoBuf = await pngToIco(tmpPngPaths);
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), icoBuf);
    console.log(`  ✅ icon.ico: ${(icoBuf.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.warn('  ⚠️ png-to-ico失败，将依赖electron-builder自动转换:', err.message);
  }

  // 清理临时文件
  console.log('\n🧹 清理临时文件...');
  for (const p of tmpPngPaths) {
    try { fs.unlinkSync(p); } catch (e) {}
  }

  // 清理旧文件
  ['icon-256.png', 'icon-512.png', 'icon-1024.png'].forEach(f => {
    const p = path.join(BUILD_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e){} }
  });

  console.log('\n✅ 所有图标生成完成!');
  console.log('\n📋 build/ 目录:');
  console.log('  icon-source.jpg - 源图片');
  console.log('  icon.png        - 1024x1024 PNG (主源)');
  console.log('  icon.ico        - Windows ICO (预构建，多尺寸)');
}

generateIcons().catch(err => {
  console.error('❌ 生成图标失败:', err);
  process.exit(1);
});
