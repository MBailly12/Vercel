import chalk from 'chalk';
import execa from 'execa';
import npa from 'npm-package-arg';
import mkdirp from 'mkdirp-promise';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { funCacheDir } from '@zeit/fun';
import cacheDirectory from 'cache-or-tmp-directory';
import { readFile, writeFile, readJSON, writeJSON, remove } from 'fs-extra';

import {
  NoBuilderCacheError,
  BuilderCacheCleanError
} from '../errors-ts';
import wait from '../output/wait';
import { Output } from '../output';

import * as staticBuilder from './static-builder';
import { BuilderWithPackage, Package } from './types';

const localBuilders: { [key: string]: BuilderWithPackage } = {
  '@now/static': {
    runInProcess: true,
    builder: Object.freeze(staticBuilder),
    package: { version: '' }
  }
};

const registryTypes = new Set(['version', 'tag', 'range']);

export const cacheDirPromise = prepareCacheDir();
export const builderDirPromise = prepareBuilderDir();
export const builderModulePathPromise = prepareBuilderModulePath();

/**
 * Prepare cache directory for installing now-builders
 */
export async function prepareCacheDir() {
  const { NOW_BUILDER_CACHE_DIR } = process.env;
  const designated = NOW_BUILDER_CACHE_DIR
    ? resolve(NOW_BUILDER_CACHE_DIR)
    : cacheDirectory('co.zeit.now');

  if (!designated) {
    throw new NoBuilderCacheError();
  }

  const cacheDir = join(designated, 'dev');
  await mkdirp(cacheDir);
  return cacheDir;
}

export async function prepareBuilderDir() {
  const builderDir = join(await cacheDirPromise, 'builders');
  await mkdirp(builderDir);

  // Create an empty private `package.json`,
  // but only if one does not already exist
  try {
    const buildersPkg = join(builderDir, 'package.json');
    await writeJSON(buildersPkg, { private: true }, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }

  return builderDir;
}

export async function prepareBuilderModulePath() {
  const [builderDir, builderContents] = await Promise.all([
    builderDirPromise,
    readFile(join(__dirname, 'builder-worker.js'))
  ]);
  let needsWrite = false;
  const builderSha = getSha(builderContents);
  const cachedBuilderPath = join(builderDir, 'builder.js');

  try {
    const cachedBuilderContents = await readFile(cachedBuilderPath);
    const cachedBuilderSha = getSha(cachedBuilderContents);
    if (builderSha !== cachedBuilderSha) {
      needsWrite = true;
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      needsWrite = true;
    } else {
      throw err;
    }
  }

  if (needsWrite) {
    await writeFile(cachedBuilderPath, builderContents);
  }

  return cachedBuilderPath;
}

// Is responsible for cleaning the cache
export async function cleanCacheDir(output: Output): Promise<void> {
  const cacheDir = await cacheDirPromise;
  try {
    output.log(chalk`{magenta Deleting} ${cacheDir}`);
    await remove(cacheDir);
  } catch (err) {
    throw new BuilderCacheCleanError(cacheDir, err.message);
  }

  try {
    await remove(funCacheDir);
    output.log(chalk`{magenta Deleting} ${funCacheDir}`);
  } catch (err) {
    throw new BuilderCacheCleanError(funCacheDir, err.message);
  }
}

/**
 * Install a list of builders to the cache directory.
 */
export async function installBuilders(
  packagesSet: Set<string>,
  yarnDir: string
): Promise<void> {
  const packages = Array.from(packagesSet);
  if (
    packages.length === 0 ||
    (packages.length === 1 &&
      Object.hasOwnProperty.call(localBuilders, packages[0]))
  ) {
    // Static deployment, no builders to install
    return;
  }
  const cacheDir = await builderDirPromise;
  const yarnPath = join(yarnDir, 'yarn');

  const buildUtilsVersion = packages.some(p => p.includes('@canary')) ? 'canary' : 'latest';

  const stopSpinner = wait(
    `Installing builders: ${packages.sort().join(', ')}`
  );
  try {
    await execa(
      process.execPath,
      [
        yarnPath,
        'add',
        '--exact',
        '--no-lockfile',
        `$@now/build-utils@${buildUtilsVersion}`,
        ...packages.filter(p => p !== '@now/static')
      ],
      {
        cwd: cacheDir
      }
    );
  } finally {
    stopSpinner();
  }
}

/**
 * Get a builder from the cache directory.
 */
export async function getBuilder(
  builderPkg: string
): Promise<BuilderWithPackage> {
  let builderWithPkg: BuilderWithPackage = localBuilders[builderPkg];
  if (!builderWithPkg) {
    const cacheDir = await builderDirPromise;
    const parsed = npa(builderPkg);
    const buildersPkg = await readJSON(join(cacheDir, 'package.json'));
    const pkgName = getPackageName(parsed, buildersPkg) || builderPkg;
    const dest = join(cacheDir, 'node_modules', pkgName);
    const mod = require(dest);
    const pkg = require(join(dest, 'package.json'));
    builderWithPkg = Object.freeze({
      builder: mod,
      package: pkg
    });
  }
  return builderWithPkg;
}

function getPackageName(
  parsed: npa.Result,
  buildersPkg: Package
): string | null {
  if (registryTypes.has(parsed.type)) {
    return parsed.name;
  }
  const deps = { ...buildersPkg.devDependencies, ...buildersPkg.dependencies };
  for (const [name, dep] of Object.entries(deps)) {
    if (dep === parsed.raw) {
      return name;
    }
  }
  return null;
}

function getSha(buffer: Buffer): string {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}
