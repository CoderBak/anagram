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
  flavor?: "native" | "oneclick";
  adapted?: string[];
  group: string;
}
export function components(): Component[];
export function bundledPackages(): Map<string, { component: string; chunk?: string; flavor?: "native" | "oneclick" }>;
export function packageOfModule(id: string): string | null;
export function unlistedPackages(packages: Iterable<string>): string[];
export function render(): string;
