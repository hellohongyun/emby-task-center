/** Built-in artwork shared by management pages and Emby virtual folders. */
export const DEFAULT_LIBRARY_POSTER_TAG = "system-library-poster-v1";
export const DEFAULT_LIBRARY_POSTER_ASPECT_RATIO = 16 / 9;
export const DEFAULT_LIBRARY_POSTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<defs>
  <linearGradient id="background" x2="1" y2="1"><stop stop-color="#173e4a"/><stop offset="1" stop-color="#101c31"/></linearGradient>
  <linearGradient id="film" x2="1" y2="1"><stop stop-color="#c8f7e9"/><stop offset="1" stop-color="#63cbb3"/></linearGradient>
</defs>
<rect width="960" height="540" rx="24" fill="url(#background)"/>
<circle cx="830" cy="70" r="220" fill="#5cd4b5" opacity=".06"/>
<circle cx="110" cy="520" r="220" fill="#72a9ed" opacity=".07"/>
<rect x="324" y="128" width="312" height="210" rx="26" fill="none" stroke="url(#film)" stroke-width="8"/>
<path d="M365 130v205m230-205v205" stroke="#88decb" stroke-width="6" opacity=".65"/>
<path d="M339 172h12m-12 49h12m-12 49h12m-12 49h12m258-147h12m-12 49h12m-12 49h12m-12 49h12" stroke="#88decb" stroke-width="12" stroke-linecap="round"/>
<path d="m455 190 75 43-75 43z" fill="url(#film)"/>
<text x="480" y="409" fill="#e5f7f3" font-family="system-ui, sans-serif" font-size="34" font-weight="600" letter-spacing="9" text-anchor="middle">媒体库</text>
<text x="480" y="450" fill="#95b8bf" font-family="system-ui, sans-serif" font-size="16" letter-spacing="5" text-anchor="middle">MEDIA LIBRARY</text>
</svg>`;
export const DEFAULT_LIBRARY_POSTER_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DEFAULT_LIBRARY_POSTER_SVG)}`;
