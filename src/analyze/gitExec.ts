import { execFile } from 'child_process';

export async function execGit(
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout: 1500, maxBuffer: 1024 * 1024 },
      // Typed as possibly undefined on purpose: when the process is killed by
      // the timeout, the callback can be invoked without stream contents, and
      // the @types signature does not admit that.
      (err: unknown, stdout: string | Buffer | undefined, stderr: string | Buffer | undefined) => {
      if (err) {
        resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        return;
      }
      resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}
