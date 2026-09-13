// lib/ui/theme.ts — extension pages (popup / options / onboarding) are styled with
// Basecoat's "Vega" pack (lib/ui/basecoat-vega.cdn.min.css, vendored from the
// basecoat-css npm package, MIT). Basecoat's dark mode is the `dark` class on <html>;
// we follow the OS setting live. Inline scripts are barred by the MV3 page CSP, so
// this runs from each page's module script.
export function followSystemTheme(): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    document.documentElement.classList.toggle("dark", mq.matches);
  };
  apply();
  mq.addEventListener("change", apply);
}
