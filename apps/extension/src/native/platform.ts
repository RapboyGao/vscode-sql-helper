export function nativePlatformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

