const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SOURCE = path.join(BUILD_DIR, 'icon-source.jpg');

async function generateIcons() {
  console.log('开始生成图标...');

  if (!fs.existsSync(SOURCE)) {
    console.error('源文件不存在:', SOURCE);
    process.exit(1);
  }

  const metadata = await sharp(SOURCE).metadata();
  console.log('源图片尺寸:', metadata.width, 'x', metadata.height);

  // 裁剪策略：图片1024x1024，底部约10-12%是"FlowX"文字区域
  // 顶部保留少量空间，底部裁掉文字
  // 图标主体（深蓝色圆角方形）大约在 y:85 到 y:880 区域
  const topCrop = 70;  // 顶部裁掉70px
  const bottomCrop = 100; // 底部裁掉100px（去掉FlowX文字）
  const cropHeight = metadata.height - topCrop - bottomCrop;
  const cropWidth = cropHeight; // 正方形
  const left = Math.floor((metadata.width - cropWidth) / 2);
  const top = topCrop;
  
  console.log(`裁剪区域: ${cropWidth}x${cropHeight}，从 (${left}, ${top}) 开始`);

  // 生成 1024x1024 PNG（electron-builder会自动转换为各平台格式）
  console.log('生成 icon.png (1024x1024)...');
  await sharp(SOURCE)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(1024, 1024, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.png'));
  
  console.log('✅ icon.png 已保存 (1024x1024)');

  // 同时生成一个 256x256 版本备用
  console.log('生成 icon-256.png (256x256)...');
  await sharp(SOURCE)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(256, 256, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(path.join(BUILD_DIR, 'icon-256.png'));
  
  console.log('✅ icon-256.png 已保存');

  console.log('\n✅ 图标生成完成! electron-builder会自动将PNG转换为各平台格式');
}

generateIcons().catch(err => {
  console.error('生成图标失败:', err);
  process.exit(1);
});
