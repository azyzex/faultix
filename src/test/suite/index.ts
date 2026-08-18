import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd' });
  mocha.timeout(100000);

  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    glob('**/*.test.js', { cwd: testsRoot })
      .then((files) => {
        files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

        try {
          mocha.run((failures: number) => {
            if (failures > 0) {
              reject(new Error(`${failures} tests failed.`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}
