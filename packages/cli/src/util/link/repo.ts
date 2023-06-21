import chalk from 'chalk';
import inquirer from 'inquirer';
import pluralize from 'pluralize';
import { homedir } from 'os';
import { basename, join, normalize } from 'path';
import frameworks from '@vercel/frameworks';
import { normalizePath } from '@vercel/build-utils';
import {
  detectFramework,
  getWorkspacePackagePaths,
  getWorkspaces,
  LocalFileSystemDetector,
} from '@vercel/fs-detectors';
import { lstat, readJSON, outputJSON } from 'fs-extra';
import confirm from '../input/confirm';
import toHumanPath from '../humanize-path';
import { VERCEL_DIR, VERCEL_DIR_REPO, writeReadme } from '../projects/link';
import { getRemoteUrls } from '../create-git-meta';
import link from '../output/link';
import { emoji, prependEmoji } from '../emoji';
import selectOrg from '../input/select-org';
import { addToGitIgnore } from './add-to-gitignore';
import type Client from '../client';
import type { Project } from '@vercel-internals/types';
import createProject from '../projects/create-project';

const home = homedir();

export interface RepoProjectConfig {
  id: string;
  name: string;
  directory: string;
}

export interface RepoProjectsConfig {
  orgId: string;
  remoteName: string;
  projects: RepoProjectConfig[];
}

export interface RepoLink {
  rootPath: string;
  repoConfigPath: string;
  repoConfig?: RepoProjectsConfig;
}

export interface EnsureRepoLinkOptions {
  yes: boolean;
  overwrite: boolean;
}

/**
 * Given a directory path `cwd`, finds the root of the Git repository
 * and returns the parsed `.vercel/repo.json` file if the repository
 * has already been linked.
 */
export async function getRepoLink(
  client: Client,
  cwd: string
): Promise<RepoLink | undefined> {
  // Determine where the root of the repo is
  const rootPath = await findRepoRoot(client, cwd);
  if (!rootPath) return undefined;

  // Read the `repo.json`, if this repo has already been linked
  const repoConfigPath = join(rootPath, VERCEL_DIR, VERCEL_DIR_REPO);
  const repoConfig: RepoProjectsConfig = await readJSON(repoConfigPath).catch(
    err => {
      if (err.code !== 'ENOENT') throw err;
    }
  );

  return { rootPath, repoConfig, repoConfigPath };
}

async function detectProjects(cwd: string) {
  const fs = new LocalFileSystemDetector(cwd);
  const workspaces = await getWorkspaces({ fs });
  const detectedProjects = new Map<string, string>();
  if (workspaces.length === 0) detectedProjects;
  // TODO: get package paths for all workspaces
  const packagePaths = await getWorkspacePackagePaths({
    fs,
    workspace: workspaces[0],
  });
  await Promise.all(
    packagePaths.map(async p => {
      const framework = await detectFramework({
        fs: fs.chdir(join('.', p)),
        frameworkList: frameworks,
      });
      if (!framework) return;
      detectedProjects.set(p.slice(1), framework);
    })
  );
  return detectedProjects;
}

export async function ensureRepoLink(
  client: Client,
  cwd: string,
  { yes, overwrite }: EnsureRepoLinkOptions
): Promise<RepoLink | undefined> {
  const { output } = client;

  const repoLink = await getRepoLink(client, cwd);
  if (repoLink) {
    output.debug(`Found Git repository root directory: ${repoLink.rootPath}`);
  } else {
    throw new Error('Could not determine Git repository root directory');
  }
  let { rootPath, repoConfig, repoConfigPath } = repoLink;

  if (overwrite || !repoConfig) {
    // Detect the projects on the filesystem out of band, so that
    // they will be ready by the time the projects are listed
    const detectedProjectsPromise = detectProjects(rootPath).catch(err => {
      output.debug(`Failed to detect local projects: ${err}`);
      return new Map<string, string>();
    });

    // Not yet linked, so prompt user to begin linking
    let shouldLink =
      yes ||
      (await confirm(
        client,
        `Link Git repository at ${chalk.cyan(
          `“${toHumanPath(rootPath)}”`
        )} to your Project(s)?`,
        true
      ));

    if (!shouldLink) {
      output.print(`Canceled. Repository not linked.\n`);
      return;
    }

    const org = await selectOrg(
      client,
      'Which scope should contain your Project(s)?',
      yes
    );
    client.config.currentTeam = org.type === 'team' ? org.id : undefined;

    const remoteUrls = await getRemoteUrls(
      join(rootPath, '.git/config'),
      output
    );
    if (!remoteUrls) {
      throw new Error('Could not determine Git remote URLs');
    }
    const remoteNames = Object.keys(remoteUrls);
    let remoteName: string;
    if (remoteNames.length === 1) {
      remoteName = remoteNames[0];
    } else {
      // Prompt user to select which remote to use
      const answer = await client.prompt({
        type: 'list',
        name: 'value',
        message: 'Which Git remote should be used?',
        choices: remoteNames.sort().map(name => {
          return { name: name, value: name };
        }),
        default: remoteNames.includes('origin') ? 'origin' : undefined,
      });
      remoteName = answer.value;
    }
    const repoUrl = remoteUrls[remoteName];
    output.spinner(
      `Fetching Projects for ${link(repoUrl)} under ${chalk.bold(org.slug)}…`
    );
    let projects: Project[] = [];
    const query = new URLSearchParams({ repoUrl });
    const projectsIterator = client.fetchPaginated<{
      projects: Project[];
    }>(`/v9/projects?${query}`);
    const detectedProjects = await detectedProjectsPromise;
    for await (const chunk of projectsIterator) {
      projects = projects.concat(chunk.projects);
      if (chunk.pagination.next) {
        output.spinner(`Found ${chalk.bold(projects.length)} Projects…`, 0);
      }
    }

    if (projects.length === 0) {
      output.log(
        `No Projects are linked to ${link(repoUrl)} under ${chalk.bold(
          org.slug
        )}.`
      );
    } else {
      output.log(
        `Found ${pluralize('Project', projects.length, true)} linked to ${link(
          repoUrl
        )} under ${chalk.bold(org.slug)}`
      );
    }

    // For any projects that already exists on Vercel, remove them from the
    // locally detected directories. Any remaining ones will be prompted to
    // create new Projects for.
    for (const project of projects) {
      detectedProjects.delete(project.rootDirectory ?? '');
    }

    if (detectedProjects.size > 0) {
      output.log(
        `Detected ${pluralize(
          'new Project',
          detectedProjects.size,
          true
        )} that may be created.`
      );
    }

    const addSeparators = projects.length > 0 && detectedProjects.size > 0;
    const { selected } = await client.prompt({
      type: 'checkbox',
      name: 'selected',
      message: `Which Projects should be ${
        projects.length ? 'linked to' : 'created'
      }?`,
      choices: [
        ...(addSeparators
          ? [new inquirer.Separator('----- Existing Projects -----')]
          : []),
        ...projects.map(project => {
          return {
            name: `${org.slug}/${project.name}`,
            value: project,
            checked: true,
          };
        }),
        ...(addSeparators
          ? [new inquirer.Separator('----- New Projects to be created -----')]
          : []),
        ...Array.from(detectedProjects.entries()).map(
          ([rootDirectory, framework]) => {
            const name = basename(rootDirectory);
            return {
              name: `${org.slug}/${name} (${framework})`,
              value: {
                newProject: true,
                rootDirectory,
                name,
                framework,
              },
            };
          }
        ),
      ],
    });
    console.log(selected);

    if (selected.length === 0) {
      output.print(`No Projects were selected. Repository not linked.\n`);
      return;
    }

    for (let i = 0; i < selected.length; i++) {
      const selection = selected[i];
      if (!selection.newProject) continue;
      // TODO: allow for editing name / framework / etc.
      selected[i] = await createProject(client, selection.name);
      output.log(`Created new Project`);
    }

    repoConfig = {
      orgId: org.id,
      remoteName,
      projects: projects.map(project => {
        return {
          id: project.id,
          name: project.name,
          directory: normalize(project.rootDirectory || ''),
        };
      }),
    };
    await outputJSON(repoConfigPath, repoConfig, { spaces: 2 });

    await writeReadme(rootPath);

    // update .gitignore
    const isGitIgnoreUpdated = await addToGitIgnore(rootPath);

    output.print(
      prependEmoji(
        `Linked to ${link(repoUrl)} under ${chalk.bold(
          org.slug
        )} (created ${VERCEL_DIR}${
          isGitIgnoreUpdated ? ' and added it to .gitignore' : ''
        })`,
        emoji('link')
      ) + '\n'
    );
  }

  return {
    repoConfig,
    repoConfigPath,
    rootPath,
  };
}

/**
 * Given a `start` directory, traverses up the directory hierarchy until
 * the nearest `.git/config` file is found. Returns the directory where
 * the Git config was found, or `undefined` when no Git repo was found.
 */
export async function findRepoRoot(
  client: Client,
  start: string
): Promise<string | undefined> {
  const { debug } = client.output;
  const REPO_JSON_PATH = join(VERCEL_DIR, VERCEL_DIR_REPO);
  const GIT_CONFIG_PATH = normalize('.git/config');

  for (const current of traverseUpDirectories(start)) {
    if (current === home) {
      // Sometimes the $HOME directory is set up as a Git repo
      // (for dotfiles, etc.). In this case it's safe to say that
      // this isn't the repo we're looking for. Bail.
      debug('Arrived at home directory');
      break;
    }

    // if `.vercel/repo.json` exists (already linked),
    // then consider this the repo root
    const repoConfigPath = join(current, REPO_JSON_PATH);
    let stat = await lstat(repoConfigPath).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (stat) {
      debug(`Found "${REPO_JSON_PATH}" - detected "${current}" as repo root`);
      return current;
    }

    // if `.git/config` exists (unlinked),
    // then consider this the repo root
    const gitConfigPath = join(current, GIT_CONFIG_PATH);
    stat = await lstat(gitConfigPath).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (stat) {
      debug(`Found "${GIT_CONFIG_PATH}" - detected "${current}" as repo root`);
      return current;
    }
  }

  debug('Aborting search for repo root');
}

export function* traverseUpDirectories(start: string) {
  let current: string | undefined = normalize(start);
  while (current) {
    yield current;
    // Go up one directory
    const next = join(current, '..');
    current = next === current ? undefined : next;
  }
}

function sortByDirectory(a: RepoProjectConfig, b: RepoProjectConfig): number {
  const aParts = a.directory.split('/');
  const bParts = b.directory.split('/');
  return bParts.length - aParts.length;
}

/**
 * Finds the matching Projects from an array of Project links
 * where the provided relative path is within the Project's
 * root directory.
 */
export function findProjectsFromPath(
  projects: RepoProjectConfig[],
  path: string
): RepoProjectConfig[] {
  const normalizedPath = normalizePath(path);
  const matches = projects
    .slice()
    .sort(sortByDirectory)
    .filter(project => {
      if (project.directory === '.') {
        // Project has no "Root Directory" setting, so any path is valid
        return true;
      }
      return (
        normalizedPath === project.directory ||
        normalizedPath.startsWith(`${project.directory}/`)
      );
    });
  // If there are multiple matches, we only want the most relevant
  // selections (with the deepest directory depth), so pick the first
  // one and filter on those matches.
  const firstMatch = matches[0];
  return matches.filter(match => match.directory === firstMatch.directory);
}
