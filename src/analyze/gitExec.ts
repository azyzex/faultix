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
      (err: unknown, stdout: string | Buffer, stderr: string | Buffer) => {
      if (err) {
        resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        return;
      }
      resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}
