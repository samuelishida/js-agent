import fs from 'fs';
import { build as esbuildBuild } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function build() {
  const manifestPath = path.join(projectRoot, 'src/skills/runtime/manifest.json');
  const inputDir = path.join(projectRoot, 'src/skills/runtime/generators');
  const outputDir = path.join(projectRoot, 'src/skills/generated/runtime');

  if (!fs.existsSync(manifestPath)) {
    console.error('Error: Manifest file not found:', manifestPath);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!fs.existsSync(inputDir)) {
    console.error('Error: Generators input directory not found:', inputDir);
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  let allSuccessful = true;

  await Promise.all(
    manifest.generators.map(async (generator) => {
      const generatorPath = path.join(inputDir, generator.id + '.cjs');

      if (!fs.existsSync(generatorPath)) {
        console.error(`Error: Generator file not found for ${generator.id}: ${generatorPath}`);
        allSuccessful = false;
        return;
      }

      try {
        const outfile = path.join(outputDir, generator.id + '.cjs');

        await esbuildBuild({
          entryPoints: [generatorPath],
          outfile,
          bundle: true,
          platform: 'node',
          target: 'node18',
          format: 'cjs',
          write: true
        });

        console.log(`Successfully generated ${generator.id}.cjs`);
      } catch (error) {
        console.error(`Error building ${generator.id}:`, error);
        allSuccessful = false;
      }
    })
  );

  if (allSuccessful) {
    const inputManifestPath = manifestPath;
    const outputManifestPath = path.join(outputDir, 'manifest.json');

    fs.copyFileSync(inputManifestPath, outputManifestPath);
    console.log('Build successful. All generators built and manifest copied');
    console.log('Output directory:', outputDir);
    process.exit(0);
  } else {
    console.error('Build errors occurred for one or more generators.');
    process.exit(1);
  }
}

build().catch(console.error);
