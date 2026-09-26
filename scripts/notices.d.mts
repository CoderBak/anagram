/** See scripts/notices.mjs. */
export const NOTICES_FILE: string;
export interface Component {
  name: string;
  version?: string;
  url: string;
  urls?: string[];
  licence: string;
  copyright: string;
  where: string;
  packages?: string[];
  chunk?: string;
  adapted?: string[];
  group: string;
}
export function components(): Component[];
export function bundledPackages(): Map<string, { component: string; chunk?: string }>;
export function packageOfModule(id: string): string | null;
export function unlistedPackages(packages: Iterable<string>): string[];
export function render(): string;
