/** Windows treats case and trailing dots/spaces as aliases of one directory. */
export function appDirectoryKey(name: string): string {
  return name.toLowerCase().replace(/[. ]+$/, '');
}

/** These suffixes identify apps added from a folder or created by the user. */
export function isPersonalAppMarketName(name: string): boolean {
  return ['mine', 'local'].includes(appDirectoryKey(name));
}
