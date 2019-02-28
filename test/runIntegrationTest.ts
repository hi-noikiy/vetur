import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as $ from 'shelljs';
import { downloadAndUnzip } from './helper';

const vscodeExecutableDir = path.join(__dirname, '../../.vscode-test/stable');

const windowsExecutable = path.join(vscodeExecutableDir, 'Code.exe');
const darwinExecutable = path.join(vscodeExecutableDir, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
const linuxExecutable = path.join(vscodeExecutableDir, 'VSCode-linux-x64', 'code');

const executable =
  process.platform === 'darwin' ? darwinExecutable : process.platform === 'win32' ? windowsExecutable : linuxExecutable;

// Windows not supported yet
const downloadPlatform = process.platform === 'darwin' ? 'darwin' : 'linux-x64';

console.log('### Vetur Integration Test ###');
console.log('');

const EXT_ROOT = path.resolve(__dirname, '../../');

function runTests(testWorkspaceRelativePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const testWorkspace = path.resolve(EXT_ROOT, testWorkspaceRelativePath, 'fixture');
    const extTestPath = path.resolve(EXT_ROOT, 'dist', testWorkspaceRelativePath);

    const args = [
      testWorkspace,
      '--extensionDevelopmentPath=' + EXT_ROOT,
      '--extensionTestsPath=' + extTestPath,
      '--locale=en'
    ];

    if (process.env.CODE_DISABLE_EXTENSIONS) {
      args.push('--disable-extensions');
    }

    console.log(`Test folder: ${path.join('dist', testWorkspaceRelativePath)}`);
    console.log(`Workspace:   ${testWorkspaceRelativePath}`);

    const cmd = cp.spawn(executable, args);

    cmd.stdout.on('data', function(data) {
      const s = data.toString();
      if (!s.includes('update#setState idle')) {
        console.log(s);
      }
    });

    cmd.on('error', function(data) {
      console.log('Test error: ' + data.toString());
    });

    cmd.on('close', function(code) {
      console.log(`Exit code:   ${code}`);

      if (code !== 0) {
        reject('Failed');
      }

      console.log('Done\n');
      resolve(code);
    });
  });
}

async function runAllTests() {
  const testDirs = fs.readdirSync(path.resolve(EXT_ROOT, './test')).filter(p => !p.includes('.'));

  for (const dir of testDirs) {
    const fixtureDir = path.resolve(EXT_ROOT, `./test/${dir}/fixture`);

    try {
      if (
        fs.existsSync(path.resolve(fixtureDir, './package.json')) &&
        !fs.existsSync(path.resolve(fixtureDir, './node_modules'))
      ) {
        $.exec('yarn install', { cwd: `test/${dir}/fixture` });
      }
      await runTests(`test/${dir}`);
    } catch (err) {
      console.error(err);
      console.error('Error running tests');
      process.exit(1);
    }
  }
}

async function go() {
  if (!fs.existsSync(executable)) {
    $.mkdir('-p', vscodeExecutableDir);
    try {
      const downloadResult = await downloadAndUnzip(vscodeExecutableDir, downloadPlatform);
      if (!downloadResult) {
        console.error('Error downloading VS Code');
        process.exit(1);
      }
      $.chmod('+x', executable);
    } catch (err) {
      console.error('Error downloading VS Code');
      process.exit(1);
    }
  }

  runAllTests();
}

go();
