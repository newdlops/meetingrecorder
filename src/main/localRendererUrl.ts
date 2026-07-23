import path from 'node:path';

export const LOCAL_RENDERER_SCHEME = 'meeting-app';
export const LOCAL_RENDERER_URL = `${LOCAL_RENDERER_SCHEME}://app/`;

export function resolveLocalRendererFile(requestUrl: string, rendererRoot: string): string {
  const url = new URL(requestUrl);

  if (
    url.protocol !== `${LOCAL_RENDERER_SCHEME}:` ||
    url.hostname !== 'app' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error('잘못된 렌더러 URL입니다.');
  }

  let requestPath = '';

  try {
    requestPath = decodeURIComponent(url.pathname);
  } catch {
    throw new Error('잘못된 렌더러 경로입니다.');
  }

  if (requestPath.includes('\0')) {
    throw new Error('잘못된 렌더러 경로입니다.');
  }

  const rootPath = path.resolve(rendererRoot);
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(rootPath, relativePath);

  if (filePath === rootPath || !filePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('렌더러 경로가 앱 자산 폴더를 벗어났습니다.');
  }

  return filePath;
}
