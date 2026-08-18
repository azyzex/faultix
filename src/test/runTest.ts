import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    const userDataDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'user-data');
    const extensionsDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'extensions');

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runTests({
          extensionDevelopmentPath,
          extensionTestsPath,
          extensionTestsEnv: {
            ...process.env,
            VSCODE_UPDATE_MODE: 'none',
            VSCODE_DISABLE_UPDATE: '1',
            VSCODE_DISABLE_UPDATES: '1',
            VSCODE_SKIP_UPDATE_CHECK: '1'
          },
          launchArgs: [
            '--disable-updates',
            '--disable-telemetry',
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${extensionsDir}`
          ]
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isUpdateMutex =
          message.includes('Code is currently being updated') ||
          message.includes('Error mutex already exists');

        if (!isUpdateMutex || attempt === maxAttempts) {
          throw err;
        }

        // Wait for any background update process to finish.
        await sleep(5000);
      }
    }
  } catch (err) {
    console.error('Failed to run tests');
    console.error(
      'If you keep seeing “Code is currently being updated”, close all VS Code instances and wait for updates to finish, then retry.'
    );
    console.error(err);
    process.exit(1);
  }
}

void main();
