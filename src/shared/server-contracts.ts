export const SERVER_PROTOCOL_VERSION = '1.0';
export const SERVER_MAX_MESSAGE_SIZE = 8 * 1024 * 1024;

export type ServerCapability =
  | 'system.hello'
  | 'system.ping'
  | 'system.health'
  | 'system.capabilities'
  | 'system.shutdown';

export interface ServerHelloParams {
  desktopVersion: string;
  protocolVersion: string;
  connectionId: string;
  workspaceRoots: string[];
}

export interface ServerHelloResult {
  serverVersion: string;
  protocolVersion: string;
  os: 'linux' | 'darwin';
  arch: 'amd64' | 'arm64';
  instanceId: string;
  startedAt: string;
  capabilities: ServerCapability[];
  limits: { maxMessageSize: number };
}

export interface ServerManifestArtifact {
  file: string;
  platform: 'linux-amd64' | 'linux-arm64' | 'darwin-amd64' | 'darwin-arm64';
  version: string;
  size: number;
  sha256: string;
}

export interface ServerManifest {
  version: string;
  generatedAt: string;
  artifacts: ServerManifestArtifact[];
}
