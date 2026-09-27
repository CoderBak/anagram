/** See scripts/flavor.mjs. */
export type Flavor = "native" | "oneclick";
export const FLAVORS: Flavor[];
export function flavorOf(env?: Record<string, string | undefined>): Flavor;
export const FLAVOR_MODULES: Record<string, Record<Flavor, string>>;
export function flavorAliases(flavor: Flavor, root: string): Record<string, string>;
export const FLAVOR_ENTRYPOINTS: Record<string, Flavor>;
export function buildsEntrypoint(flavor: Flavor, name: string): boolean;
export function outDirTemplate(flavor: Flavor): string | undefined;
export function outputDir(flavor: Flavor, browser: string, manifestVersion: number): string;
export const ONECLICK_PUBLIC: string;
