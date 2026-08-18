import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

/** Entry point the Extension Host calls to run the integration suite. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  const testsRoot = path.resolve(__dirname, '.');

  return glob('**/*.test.js', { cwd: testsRoot }).then(
    (files) =>
      new Promise<void>((resolve, reject) => {
        for (const file of files) {
          mocha.addFile(path.resolve(testsRoot, file));
        }

        try {
          mocha.run((failures) => {
            if (failures > 0) {
              reject(new Error(`${failures} integration test(s) failed.`));
            } else {
              resolve();
            }
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
  );
}
