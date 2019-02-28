import axios from 'axios';
import * as unzipper from 'unzipper';
import * as tar from 'tar';

export async function downloadAndUnzip(vscodeExecutablePath: string, downloadPlatform: string): Promise<boolean> {
  const downloadUrl = await getDownloadUrl(downloadPlatform);
  console.log('Downloading VS Code into "' + vscodeExecutablePath + '" from: ' + downloadUrl);

  const res = await axios.get(downloadUrl, {
    responseType: 'stream',
    headers: { 'user-agent': 'nodejs' }
  });
  if (res.status !== 200 || !res.data) {
    throw Error('Failed to download latest release from update server');
  }

  return new Promise<boolean>((resolve, reject) => {
    if (res.data.responseUrl.endsWith('.zip')) {
      res.data
        .pipe(unzipper.Extract({ path: vscodeExecutablePath }))
        .on('error', () => {
          reject(false);
        })
        .on('close', () => {
          resolve(true);
        });
    } else if (res.data.responseUrl.endsWith('.tar.gz')) {
      res.data
        .pipe(tar.extract({ cwd: vscodeExecutablePath }))
        .on('error', () => {
          reject(false);
        })
        .on('close', () => {
          resolve(true);
        });
    } else {
      reject(false);
    }
  });
}

async function getDownloadUrl(downloadPlatform: string) {
  const url = `https://update.code.visualstudio.com/api/releases/stable/${downloadPlatform}`;

  try {
    const res = await axios.get(url);
    if (res.status !== 200 || !res.data) {
      throw Error('Failed to get latest release version from update server');
    }
    const versions = res.data;

    return `https://update.code.visualstudio.com/${versions[0]}/${downloadPlatform}/stable`;
  } catch (err) {
    throw Error('Failed to get latest release version from update server');
  }
}
