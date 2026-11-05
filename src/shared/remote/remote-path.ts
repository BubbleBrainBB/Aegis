// A project on another Mac has no path here. This placeholder stands in for one, so the
// composer and session list can treat it like any project; its last part is the name.
const REMOTE_PROJECT = /^\/aegis-remote\/([a-f0-9]{12})\/([^/]+)\/([^/]+)$/;

export const remoteProjectPath = (hostId: string, projectId: string, name: string) =>
  `/aegis-remote/${hostId}/${projectId}/${name.replace(/\//g, "-") || "project"}`;

export function parseRemoteProjectPath(path: string | null | undefined) {
  const match = path ? REMOTE_PROJECT.exec(path) : null;
  return match ? { hostId: match[1], projectId: match[2], name: match[3] } : null;
}
