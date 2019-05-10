import fs from 'fs';
import path from 'path';
import tar from 'tar-fs';
import chalk from 'chalk';
import fetch from 'node-fetch';

// @ts-ignore
import listInput from '../../util/input/list';
import promptBool from '../../util/input/prompt-bool';
import toHumanPath from '../../util/humanize-path';
import wait from '../../util/output/wait';
import { Output } from '../../util/output';
import { NowContext } from '../../types';
import success from '../../util/output/success';
import info from '../../util/output/info';
import cmd from '../../util/output/cmd';
import didYouMean from '../../util/init/did-you-mean';

type Options = {
  '--debug': boolean;
  '--force': boolean;
  '-f': boolean;
};

const EXAMPLE_API = 'https://now-example-files.zeit.sh';

export default async function init(
  ctx: NowContext,
  opts: Options,
  args: string[],
  output: Output
) {
  const [name, dir] = args;
  const force = opts['-f'] || opts['--force'];
/*
  if (!name) {
    if (builds) {
      const nowJson = new Uint8Array(Buffer.from(
        JSON.stringify({
          version: 2,
          name,
          builds
        }, null, 2)
      ))
      fs.writeFile('now.json', nowJson, { flag: 'wx', encoding: 'utf8' }, (err) => {
        if (err) {
          if (err.code !== 'EEXIST') throw err
          output.log('A now.json already exists')
        } else {
          output.log('The now.json was generated automatically with the following builders:')
          builds.forEach((build) => output.log(`${build.use} at ${build.src}`))
        }
      })

      const nowIgnore = new Uint8Array(Buffer.from(ignore.join('\n')))
      fs.writeFile('.nowignore', nowIgnore, { flag: 'wx', encoding: 'utf8' }, (err) => {
        if (err) {
          if (err.code !== 'EEXIST') throw err
          output.log('A .nowignore already exists')
        } else {
          output.log('The .nowignore was generated automatically with the following rules:')
          ignore.forEach((ig) => output.log(ig))
        }
      })

      return
    }
    output.log('No builders could be found automatically... start from an example instead?')
  }
*/
  const exampleList = await fetchExampleList();

  if (!exampleList) {
    throw new Error(`Could not get examle list.`);
  }

  if (!name) {
    const chosen = await chooseFromDropdown(exampleList);

    if (!chosen) {
      output.log('Aborted');
      return 0;
    }

    return extractExample(chosen, dir, force);
  }


  if (exampleList.includes(name)) {
    return extractExample(name, dir, force);
  }

  const found = await guess(exampleList, name, dir);

  if (typeof found === 'string') {
    return extractExample(found, dir, force);
  }

  console.log(info('No changes made.'));
  return 0;
}

/**
 * Fetch example list json
 */
async function fetchExampleList() {
  const stopSpinner = wait('Fetching examples');
  const url = `${EXAMPLE_API}/list.json`;

  try {
    const resp = await fetch(url);
    stopSpinner();

    if (resp.status !== 200) {
      throw new Error(`Failed fetching list.json (${resp.statusText}).`);
    }

    return resp.json();
  } catch (e) {
    stopSpinner();
  }
}

/**
 * Prompt user for choosing which example to init
 */
async function chooseFromDropdown(exampleList: string[]) {
  const choices = exampleList.map(name => ({
    name,
    value: name,
    short: name
  }));

  return listInput({
    message: 'Select example:',
    separator: false,
    choices
  });
}

/**
 * Extract example to directory
 */
async function extractExample(name: string, dir: string, force?: boolean) {
  const stopSpinner = wait(`Fetching ${name}`);

  const url = `${EXAMPLE_API}/download/${name}.tar.gz`;
  return fetch(url)
    .then(async resp => {
      if (resp.status !== 200) {
        throw new Error(`Could not get ${name}.tar.gz`);
      }

      stopSpinner();

      const folder = prepareFolder(process.cwd(), dir || name, force);

      await new Promise((resolve, reject) => {
        const extractor = tar.extract(folder);
        resp.body.on('error', reject);
        extractor.on('error', reject);
        extractor.on('finish', resolve);
        resp.body.pipe(extractor);
      });

      const successLog = `Initialized "${chalk.bold(name)}" example in ${chalk.bold(toHumanPath(folder))}.`;
      const folderRel = path.relative(process.cwd(), folder);
      const deployHint = folderRel === ''
        ? `To deploy, run ${cmd('now')}.`
        : `To deploy, ${cmd(`cd ${folderRel}`)} and run ${cmd('now')}.`;
      console.log(success(`${successLog} ${deployHint}`));

      return 0;
    })
    .catch(e => {
      stopSpinner();
      throw e;
    });
}

/**
 * Check & prepare destination folder for extracting.
 */
function prepareFolder(cwd: string, folder: string, force?: boolean) {
  const dest = path.join(cwd, folder);

  if (fs.existsSync(dest)) {
    if (!fs.lstatSync(dest).isDirectory()) {
      throw new Error(
        `Destination path "${chalk.bold(folder)}" already exists and is not a directory.`
      );
    }
    if (!force && fs.readdirSync(dest).length !== 0) {
      throw new Error(
        `Destination path "${chalk.bold(folder)}" already exists and is not an empty directory. You may use ${cmd('--force')} or ${cmd('--f')} to override it.`
      );
    }
  } else if (dest !== cwd) {
      try {
        fs.mkdirSync(dest);
      } catch (e) {
        throw new Error(`Could not create directory "${chalk.bold(folder)}".`);
      }
    }

  return dest;
}

/**
 * Guess which example user try to init
 */
async function guess(exampleList: string[], name: string, dir: string) {
  const GuessError = new Error(`No example for ${chalk.bold(name)}.`);

  if (process.stdout.isTTY !== true) {
    throw GuessError;
  }

  const found = didYouMean(name, exampleList, 0.7);

  if (typeof found === 'string') {
    if (await promptBool(`Did you mean ${chalk.bold(found)}?`)) {
      return found;
    }
  } else {
    throw GuessError;
  }
}
