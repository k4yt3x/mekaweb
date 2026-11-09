export function MekaStudioLink() {
  return (
    <a href="https://github.com/k4yt3x/meka-studio" target="_blank" rel="noreferrer noopener">
      Meka Studio
    </a>
  );
}

/** Meka's logo, as its app icon draws it; beside its name, it says nothing more. */
export function MekaLogo() {
  return <img className="meka-logo" src={`${import.meta.env.BASE_URL}meka-192.png`} alt="" />;
}
