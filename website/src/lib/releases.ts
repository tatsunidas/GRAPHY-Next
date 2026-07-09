/**
 * Build-time GitHub Releases fetch.
 *
 * Runs in Astro page frontmatter (server, at build). We resolve the latest
 * release's version and per-OS installer URLs and bake them into the static
 * HTML — no client-side GitHub API calls (avoids rate limits / CSP issues).
 *
 * If the API is unavailable at build time (offline, rate-limited), we degrade
 * gracefully to a "see releases page" fallback so the build never fails.
 */

export type OS = 'windows' | 'macos' | 'linux' | 'web' | 'other';

export interface ReleaseAsset {
  name: string;
  url: string;
  os: OS;
  size?: number;
}

export interface Release {
  version: string;
  htmlUrl: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
  /** false when the release could not be fetched (fallback state) */
  available: boolean;
}

function classify(name: string): OS {
  const n = name.toLowerCase();
  if (n.endsWith('.exe') || n.includes('setup')) return 'windows';
  if (n.endsWith('.dmg') || n.endsWith('.pkg')) return 'macos';
  if (n.endsWith('.appimage') || n.endsWith('.deb') || n.endsWith('.rpm')) return 'linux';
  if (n.endsWith('.jar')) return 'web';
  return 'other';
}

export async function getLatestRelease(repo: string): Promise<Release> {
  const releasesPage = `https://github.com/${repo}/releases`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'graphy-website-build',
        // GITHUB_TOKEN lifts the anonymous rate limit during CI builds if present.
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data: any = await res.json();
    const assets: ReleaseAsset[] = (data.assets ?? []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      os: classify(a.name),
      size: a.size,
    }));
    return {
      version: (data.tag_name ?? '').replace(/^v/, ''),
      htmlUrl: data.html_url ?? releasesPage,
      publishedAt: data.published_at,
      assets,
      available: true,
    };
  } catch {
    return { version: '', htmlUrl: releasesPage, assets: [], available: false };
  }
}

export function assetFor(release: Release, os: OS): ReleaseAsset | undefined {
  return release.assets.find((a) => a.os === os);
}

export const OS_LABEL: Record<OS, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: 'Web (jar)',
  other: 'その他',
};
