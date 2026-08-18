/**
 * Integration test launcher.
 *
 * Downloads a VS Code build, creates a throwaway workspace containing a file
 * that fails to compile, and runs the integration suite inside a real
 * Extension Host. The unit suite runs separately under plain mocha; this one
 * exists to prove the parts that only exist inside VS Code - activation,
 * command registration, settings, and writing into a workspace.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a disposable workspace with something genuinely broken in it. */
function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faultix-itest-'));

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'broken.py'),
    ['def crash():', '    data = {"count": 0}', '    return 10 / data["count"]', '', 'crash()', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Faultix integration workspace\n\nGenerated per test run; safe to delete.\n'
  );

  return root;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './integration/index');

  const workspace = createWorkspace();
  const userDataDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'user-data');
  const extensionsDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'extensions');

  const maxAttempts = 3;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runTests({
          extensionDevelopmentPath,
          extensionTestsPath,
          extensionTestsEnv: {
            ...process.env,
            FAULTIX_TEST_WORKSPACE: workspace,
            VSCODE_SKIP_UPDATE_CHECK: '1'
          },
          launchArgs: [
            workspace,
            '--disable-extensions',
            '--disable-updates',
            '--disable-telemetry',
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            '--no-sandbox',
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${extensionsDir}`
          ]
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // VS Code refuses to launch while it is updating itself, which happens
        // often enough on a developer machine to be worth retrying.
        const isUpdateMutex =
          message.includes('Code is currently being updated') || message.includes('Error mutex already exists');

        if (!isUpdateMutex || attempt === maxAttempts) {
          throw error;
        }
        await sleep(5000);
      }
    }
  } catch (error) {
    console.error('Integration tests failed.');
    console.error(
      'If you keep seeing "Code is currently being updated", close every VS Code window, let the update finish, then retry.'
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
