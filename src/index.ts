import fs from 'fs';
import ora from 'ora';
import path from 'path';
import sharp from 'sharp';
import chalk from 'chalk';
import { glob } from 'glob';
import inquirer from 'inquirer';
import { pastel } from 'gradient-string';

import _ from 'lodash';

const sizes = [
  // { name: 'xs', width: 160 },
  { name: 'sm', width: 320 },
  // { name: 'md', width: 720 },
  { name: 'lg', width: 1080 },
];

enum Folders {
  ORIGINALS = 'originals',
  OPTIMIZED = 'optimized',
  CDN = 'cdn',
}

enum ImageFormat {
  JPEG = 'jpeg',
  PNG = 'png',
  WEBP = 'webp',
  AVIF = 'avif',
}

const formatChoices = Object.values(ImageFormat);
export function buildCdnJson(
  images: string[],
  targetDir: string,
  format: ImageFormat
) {
  const cdnData: Record<string, any> = {};

  images.forEach((filePath) => {
    const relativePath = path.relative(targetDir, filePath);
    const parts = relativePath.split(path.sep);
    const fileNameBase = path.basename(filePath, path.extname(filePath));

    const sources: Record<string, string> = {};

    sizes.forEach((size) => {
      const fileName = `${fileNameBase}.${format}`;
      const url = `https://cdn.jsdelivr.net/gh/monarchelite/vision-assets@main/assets/optimized/${parts
        .slice(0, -1)
        .join('/')}/${size.name}/${fileName}`;

      sources[size.name] = url;
    });

    // Build nested object by folder structure
    let current = cdnData;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }

    // Store image by kebab-case name with sources object
    current[_.kebabCase(fileNameBase)] = {
      sources,
    };
  });

  // Write cdn.json
  const cdnFolder = path.join(process.cwd(), Folders.CDN);
  if (!fs.existsSync(cdnFolder)) fs.mkdirSync(cdnFolder, { recursive: true });

  fs.writeFileSync(
    path.join(cdnFolder, 'cdn.json'),
    JSON.stringify(cdnData, null, 2)
  );

  console.log('CDN JSON file generated at:', path.join(cdnFolder, 'cdn.json'));
}

export function buildCdnTs(
  images: string[],
  targetDir: string,
  format: ImageFormat
) {
  const importLines: string[] = [];
  const cdnData: Record<string, any> = {};
  const usedVarNames = new Set<string>();

  images.forEach((filePath) => {
    const relativePath = path.relative(targetDir, filePath); // e.g., rooms/night/room1.png
    const parts = relativePath.split(path.sep);
    const fileNameBase = path.basename(filePath, path.extname(filePath));

    const sources: Record<string, string> = {};

    sizes.forEach((size) => {
      const fileName = `${fileNameBase}.${format}`;

      // Generate unique camelCase import variable
      let importVar = _.camelCase(
        [...parts.slice(0, -1), fileNameBase, size.name].join('_')
      );
      let counter = 1;
      while (usedVarNames.has(importVar)) {
        importVar = `${importVar}${counter}`;
        counter++;
      }
      usedVarNames.add(importVar);

      const importPath = `raw:assets/rooms/${parts.slice(0, -1).join('/')}/${
        size.name
      }/${fileName}`;
      importLines.push(`import ${importVar} from "${importPath}";`);

      sources[size.name] = importVar;
    });

    // Build nested object by folder structure
    let current = cdnData;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }

    // Store images by name to avoid overwriting
    current[fileNameBase] = {
      // name: fileNameBase,
      sources: sources,
    };
  });

  const tsContent = `
${importLines.join('\n')}

const cdn = ${JSON.stringify(cdnData, null, 2).replace(
    /"sources":\s*{([^}]+)}/g, // match sources object
    (match) => match.replace(/"([^"]+)":\s*"([^"]+)"/g, '$1: $2') // remove quotes from values only
  )};

export default cdn;
`;

  const cdnFolder = path.join(process.cwd(), Folders.CDN);
  if (!fs.existsSync(cdnFolder)) fs.mkdirSync(cdnFolder, { recursive: true });

  fs.writeFileSync(path.join(cdnFolder, 'cdn.ts'), tsContent);

  console.log('CDN TS file generated at:', path.join(cdnFolder, 'cdn.ts'));
}
async function main() {
  // Automatically detect /assets/originals
  let defaultDir = path.join(process.cwd(), Folders.ORIGINALS);
  if (!fs.existsSync(defaultDir)) defaultDir = process.cwd();

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'dir',
      message: 'Enter the directory to optimize images:',
      default: defaultDir,
    },
    {
      type: 'list',
      name: 'format',
      message: 'Select output format:',
      choices: formatChoices,
      default: ImageFormat.WEBP,
    },
    {
      type: 'input',
      name: 'quality',
      message: 'Set image quality (1-100):',
      default: '80',
      validate: (value) => {
        const num = parseInt(value);
        return num > 0 && num <= 100 ? true : 'Enter a number between 1-100';
      },
    },
  ]);

  const targetDir = path.resolve(answers.dir);
  const quality = parseInt(answers.quality);
  const format = answers.format as ImageFormat;

  // Find all images
  const imagePatterns = [
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.png',
    '**/*.gif',
    '**/*.webp',
    '**/*.tiff',
    '**/*.tif',
    '**/*.avif',
    '**/*.bmp',
    '**/*.heic',
  ];

  const images: string[] = [];
  imagePatterns.forEach((pattern) => {
    const found = glob.sync(pattern, { cwd: targetDir, absolute: true });
    images.push(...found);
  });

  if (images.length === 0) {
    console.log(chalk.red('No images found in directory:'), targetDir);
    process.exit(0);
  }

  console.log(chalk.green(`Found ${images.length} images in ${targetDir}`));

  const spinner = ora('Optimizing images...').start();

  async function optimizeImage(filePath: string) {
    const ext = format;

    for (const size of sizes) {
      // Compute relative path from original directory
      const relativePath = path.relative(targetDir, filePath);

      // Build output path:
      // /optimized/<original-subfolders>/<size>/<filename>.<hash>.<ext>
      const outputPath = path.join(
        process.cwd(),
        Folders.OPTIMIZED,
        path.dirname(relativePath),
        size.name,
        `${path.basename(filePath, path.extname(filePath))}.${ext}`
      );

      // Ensure output folders exist
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      // Keep aspect ratio
      let pipeline = sharp(filePath).resize(size.width, undefined);

      switch (ext) {
        case ImageFormat.JPEG:
          pipeline = pipeline.jpeg({ quality, mozjpeg: true });
          break;
        case ImageFormat.PNG:
          pipeline = pipeline.png({
            quality,
            adaptiveFiltering: true,
          });
          break;
        case ImageFormat.WEBP:
          pipeline = pipeline.webp({ quality, lossless: true });
          break;
        case ImageFormat.AVIF:
          pipeline = pipeline.avif({ quality, effort: 6 });
          break;
      }

      await pipeline.toFile(outputPath);
      spinner.text = `Optimized (${size.name}): ${relativePath}`;
    }
  }

  for (const img of images) {
    await optimizeImage(img);
  }

  buildCdnJson(images, targetDir, answers.format as ImageFormat);
  buildCdnTs(images, targetDir, answers.format as ImageFormat);

  spinner.stop();

  const quotes = [
    `"Code is like humor. When you have to explain it, it’s bad." – Cory House`,
    `"First, solve the problem. Then, write the code." – John Johnson`,
    `"Programs must be written for people to read, and only incidentally for machines to execute." – Harold Abelson`,
    `"Any fool can write code that a computer can understand. Good programmers write code that humans can understand." – Martin Fowler`,
    `"Simplicity is the soul of efficiency." – Austin Freeman`,
    `"Before software can be reusable it first has to be usable." – Ralph Johnson`,
  ];

  const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];

  console.log(pastel.multiline(randomQuote));
}

main();
