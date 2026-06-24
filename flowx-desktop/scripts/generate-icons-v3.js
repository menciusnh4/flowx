const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');

async function generateIcons() {
  const BUILD_DIR = path.join(__dirname, '..', 'build');
  const SOURCE = path.join(BUILD_DIR, 'icon-source.jpg');

  console.log('=== FlowX 图标生成工具 v3 (使用 png-to-ico) ===\n');

  if (!fs.existsSync(SOURCE)) {
    console.error('❌ 源文件不存在:', SOURCE);
    process.exit(1);
  }

  const metadata = await sharp(SOURCE).metadata();
  console.log('📷 源图片:', metadata.width, 'x', metadata.height);

  // 使用完整图片
  const size = Math.min(metadata.width || 1024, metadata.height || 1024);
  const left = Math.floor(((metadata.width || 1024) - size) / 2);
  const top = Math.floor(((metadata.height || 1024) - size) / 2);

  // Windows ICO 标准尺寸（png-to-ico会处理）
  // 注意：256x256必须有，且需要是PNG格式
  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
  
  console.log('\n🔨 生成各尺寸PNG临时文件...');
  const tmpPngPaths = [];
  for (const s of ICO_SIZES) {
    const tmpPath = path.join(BUILD_DIR, `_tmp_${s}.png`);
    await sharp(SOURCE)
      .extract({ left, top, width: size, height: size })
      .resize(s, s, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(tmpPath);
    tmpPngPaths.push(tmpPath);
    const stats = fs.statSync(tmpPath);
    console.log(`  ✅ ${s}x${s}: ${stats.size} bytes`);
  }

  // 使用 png-to-ico 生成标准 Windows ICO
  console.log('\n🔨 使用 png-to-ico 生成 icon.ico...');
  try {
    const icoBuf = await pngToIco(tmpPngPaths);
    const icoPath = path.join(BUILD_DIR, 'icon.ico');
    fs.writeFileSync(icoPath, icoBuf);
    console.log(`  ✅ icon.ico: ${icoBuf.length} bytes`);
  } catch (err) {
    console.error('❌ png-to-ico 失败:', err.message);
    process.exit(1);
  }

  // 清理临时文件
  console.log('\n🧹 清理临时文件...');
  for (const p of tmpPngPaths) {
    try { fs.unlinkSync(p); } catch (e) {}
  }

  // ========== 生成 PNG 图标 ==========
  console.log('\n🔨 生成 PNG 图标...');
  
  // 256x256 PNG
  await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(256, 256, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.png'));
  console.log('  ✅ icon.png (256x256)');

  // 512x512 PNG
  await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(512, 512, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon-512.png'));
  console.log('  ✅ icon-512.png (512x512)');

  // 1024x1024 PNG
  await sharp(SOURCE)
    .extract({ left, top, width: size, height: size })
    .resize(1024, 1024, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon-1024.png'));
  console.log('  ✅ icon-1024.png (1024x1024)');

  // 删除旧的临时文件
  ['icon-256.png'].forEach(f => {
    const p = path.join(BUILD_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e){} }
  });

  console.log('\n✅ 所有图标生成完成!');
  console.log('\n📋 图标清单:');
  console.log('  build/icon.ico     - Windows (多尺寸)');
  console.log('  build/icon.png     - 256x256 PNG');
  console.log('  build/icon-512.png - 512x512 PNG');
  console.log('  build/icon-1024.png - 1024x1024 PNG');
}

generateIcons().catch(err => {
  console.error('❌ 生成图标失败:', err);
  process.exit(1);
});
