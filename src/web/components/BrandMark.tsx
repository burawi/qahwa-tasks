/** The app identity stays separate from project and user supplied avatars. */
export function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark${large ? " large" : ""}`} aria-hidden="true" data-qahwa-id={large ? "pairing-brand" : "header-brand"}>
    <img src="/icons/qahwa-violet-v1.svg" alt="" width={large ? 64 : 42} height={large ? 64 : 42} />
  </span>;
}
