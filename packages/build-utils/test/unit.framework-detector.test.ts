import path from 'path';
import frameworkList from '@vercel/frameworks';
import { detectFramework, DetectorFilesystem } from '../src';
import { Stat } from '../src/detectors/filesystem';

class VirtualFilesystem extends DetectorFilesystem {
  private files: Map<string, Buffer>;
  private cwd: string;

  constructor(files: { [key: string]: string | Buffer }, cwd = '') {
    super();
    this.files = new Map();
    this.cwd = cwd;
    Object.entries(files).map(([key, value]) => {
      const buffer = typeof value === 'string' ? Buffer.from(value) : value;
      this.files.set(key, buffer);
    });
  }

  async _hasPath(name: string): Promise<boolean> {
    const basePath = path.join(this.cwd, name);
    for (const file of this.files.keys()) {
      if (file.startsWith(basePath)) {
        return true;
      }
    }

    return false;
  }

  async _isFile(name: string): Promise<boolean> {
    const basePath = path.join(this.cwd, name);
    return this.files.has(basePath);
  }

  async _readFile(name: string): Promise<Buffer> {
    const basePath = path.join(this.cwd, name);
    const file = this.files.get(basePath);

    if (file === undefined) {
      throw new Error('File does not exist');
    }

    if (typeof file === 'string') {
      return Buffer.from(file);
    }

    return file;
  }

  /**
   * An example of how to implement readdir for a virtual filesystem.
   */
  async _readdir(name = '/'): Promise<Stat[]> {
    return (
      [...this.files.keys()]
        .map(filepath => {
          const basePath = path
            .join(this.cwd, name === '/' ? '' : name)
            .replaceAll(path.sep, '/');
          const fileDirectoryName = path.dirname(filepath);

          if (fileDirectoryName === basePath) {
            return {
              name: path.basename(filepath),
              path: filepath.replace(
                this.cwd === '' ? this.cwd : `${this.cwd}/`,
                ''
              ),
              type: 'file',
            };
          }

          if (
            (basePath === '.' && fileDirectoryName !== '.') ||
            fileDirectoryName.startsWith(basePath)
          ) {
            let subDirectoryName = fileDirectoryName.replace(
              basePath === '.' ? '' : `${basePath}/`,
              ''
            );

            if (subDirectoryName.includes('/')) {
              subDirectoryName = subDirectoryName.split('/')[0];
            }

            return {
              name: subDirectoryName,
              path:
                name === '/'
                  ? subDirectoryName
                  : [name, subDirectoryName].join('/'),
              type: 'dir',
            };
          }

          return null;
        })
        // remove nulls
        .filter((stat): stat is Stat => stat !== null)
        // remove duplicates
        .filter(
          (stat, index, self) =>
            index ===
            self.findIndex(s => s.name === stat.name && s.path === stat.path)
        )
    );
  }

  /**
   * An example of how to implement chdir for a virtual filesystem.
   */
  _chdir(name: string): DetectorFilesystem {
    const basePath = path.join(this.cwd, name).replaceAll(path.sep, '/');
    const files = Object.fromEntries(
      [...this.files.keys()].map(key => [key, this.files.get(key) ?? ''])
    );

    return new VirtualFilesystem(files, basePath);
  }
}

describe('DetectorFilesystem', () => {
  it('should return the directoy contents relative to the cwd', async () => {
    const files = {
      'package.json': '{}',
      'packages/app1/package.json': '{}',
      'packages/app2/package.json': '{}',
    };

    const fs = new VirtualFilesystem(files);

    expect(await fs.readdir('/')).toEqual([
      { name: 'package.json', path: 'package.json', type: 'file' },
      { name: 'packages', path: 'packages', type: 'dir' },
    ]);

    expect(await fs.readdir('packages')).toEqual([
      { name: 'app1', path: 'packages/app1', type: 'dir' },
      { name: 'app2', path: 'packages/app2', type: 'dir' },
    ]);

    expect(await fs.readdir('packages/app1')).toEqual([
      {
        name: 'package.json',
        path: 'packages/app1/package.json',
        type: 'file',
      },
    ]);
  });

  it('should be able to change directories', async () => {
    const nextPackageJson = JSON.stringify({
      dependencies: {
        next: '9.0.0',
      },
    });
    const gatsbyPackageJson = JSON.stringify({
      dependencies: {
        gatsby: '1.0.0',
      },
    });

    const files = {
      'package.json': '{}',
      'packages/app1/package.json': nextPackageJson,
      'packages/app2/package.json': gatsbyPackageJson,
    };

    const fs = new VirtualFilesystem(files);
    const packagesFs = fs.chdir('packages');

    expect(await packagesFs.readdir('/')).toEqual([
      { name: 'app1', path: 'app1', type: 'dir' },
      { name: 'app2', path: 'app2', type: 'dir' },
    ]);

    expect(await packagesFs.hasPath('app1')).toBeTruthy();
    expect(await packagesFs.hasPath('app3')).toBeFalsy();
    expect(await packagesFs.isFile('app1')).toBeFalsy();
    expect(await packagesFs.isFile('app1')).toBeFalsy();
    expect(await packagesFs.isFile('app1/package.json')).toBeTruthy();
    expect(await packagesFs.isFile('app2/package.json')).toBeTruthy();
    expect(
      await (await packagesFs.readFile('app1/package.json')).toString()
    ).toEqual(nextPackageJson);
    expect(
      await (await packagesFs.readFile('app2/package.json')).toString()
    ).toEqual(gatsbyPackageJson);

    expect(await detectFramework({ fs: packagesFs, frameworkList })).toBe(null);

    const nextAppFs = packagesFs.chdir('app1');

    expect(await nextAppFs.readdir('/')).toEqual([
      { name: 'package.json', path: 'package.json', type: 'file' },
    ]);

    expect(await (await nextAppFs.readFile('package.json')).toString()).toEqual(
      nextPackageJson
    );

    expect(await detectFramework({ fs: nextAppFs, frameworkList })).toBe(
      'nextjs'
    );

    const gatsbyAppFs = packagesFs.chdir('app2');

    expect(await gatsbyAppFs.readdir('/')).toEqual([
      { name: 'package.json', path: 'package.json', type: 'file' },
    ]);

    expect(
      await (await gatsbyAppFs.readFile('package.json')).toString()
    ).toEqual(gatsbyPackageJson);

    expect(await detectFramework({ fs: gatsbyAppFs, frameworkList })).toBe(
      'gatsby'
    );
  });

  describe('#detectFramework', () => {
    it('Do not detect anything', async () => {
      const fs = new VirtualFilesystem({
        'README.md': '# hi',
        'api/cheese.js': 'export default (req, res) => res.end("cheese");',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe(null);
    });

    it('Detect Next.js', async () => {
      const fs = new VirtualFilesystem({
        'package.json': JSON.stringify({
          dependencies: {
            next: '9.0.0',
          },
        }),
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('nextjs');
    });

    it('Detect Nuxt.js', async () => {
      const fs = new VirtualFilesystem({
        'package.json': JSON.stringify({
          dependencies: {
            nuxt: '1.0.0',
          },
        }),
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('nuxtjs');
    });

    it('Detect Gatsby', async () => {
      const fs = new VirtualFilesystem({
        'package.json': JSON.stringify({
          dependencies: {
            gatsby: '1.0.0',
          },
        }),
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('gatsby');
    });

    it('Detect Hugo #1', async () => {
      const fs = new VirtualFilesystem({
        'config.yaml': 'baseURL: http://example.org/',
        'content/post.md': '# hello world',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('hugo');
    });

    it('Detect Hugo #2', async () => {
      const fs = new VirtualFilesystem({
        'config.json': '{ "baseURL": "http://example.org/" }',
        'content/post.md': '# hello world',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('hugo');
    });

    it('Detect Hugo #3', async () => {
      const fs = new VirtualFilesystem({
        'config.toml': 'baseURL = "http://example.org/"',
        'content/post.md': '# hello world',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('hugo');
    });

    it('Detect Jekyll', async () => {
      const fs = new VirtualFilesystem({
        '_config.yml': 'config',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('jekyll');
    });

    it('Detect Middleman', async () => {
      const fs = new VirtualFilesystem({
        'config.rb': 'config',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('middleman');
    });

    it('Detect Scully', async () => {
      const fs = new VirtualFilesystem({
        'package.json': JSON.stringify({
          dependencies: {
            '@angular/cli': 'latest',
            '@scullyio/init': 'latest',
          },
        }),
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('scully');
    });

    it('Detect Zola', async () => {
      const fs = new VirtualFilesystem({
        'config.toml': 'base_url = "/"',
      });

      expect(await detectFramework({ fs, frameworkList })).toBe('zola');
    });
  });
});
