/**
 * Hosts that are NOT a business's own website: social networks, link-in-bio
 * pages, booking platforms, marketplaces and map/listing sites.
 *
 * A place whose "website" points here is kept (the phone can still be useful),
 * but it is never crawled for emails (scraping Instagram/Facebook is forbidden)
 * and never used for domain-based de-duplication or chain detection
 * (thousands of unrelated shops share "instagram.com").
 */
export type PlatformKind = 'SOCIAL' | 'LINK_IN_BIO' | 'BOOKING' | 'MARKETPLACE' | 'MAPS_LISTING';

/** Exact host or any subdomain of it ("m.facebook.com" matches "facebook.com"). */
const PLATFORM_HOSTS: Record<PlatformKind, string[]> = {
  SOCIAL: [
    'instagram.com', 'instagr.am', 'facebook.com', 'fb.com', 'fb.me', 'messenger.com',
    'tiktok.com', 'twitter.com', 'x.com', 't.co', 'linkedin.com', 'lnkd.in',
    'youtube.com', 'youtu.be', 'pinterest.com', 'pin.it', 'snapchat.com', 'threads.net',
    't.me', 'telegram.me', 'wa.me', 'whatsapp.com', 'viber.com', 'vk.com',
  ],
  LINK_IN_BIO: [
    'linktr.ee', 'taplink.cc', 'taplink.ws', 'taplink.at', 'beacons.ai', 'lnk.bio', 'linkin.bio',
    'bio.link', 'campsite.bio', 'msha.ke', 'allmylinks.com', 'hoo.be', 'solo.to', 'many.link',
    'tap.bio', 'linkbio.co', 'bio.site', 'direct.me', 'flow.page', 'linkpop.com',
  ],
  BOOKING: [
    'alteg.io', 'altegio.com', 'fresha.com', 'booksy.com', 'setmore.com', 'simplybook.me',
    'simplybook.it', 'calendly.com', 'vagaro.com', 'mindbodyonline.com', 'mindbody.io',
    'hey-beauty.app', 'dikidi.net', 'dikidi.ru', 'yclients.com', 'planity.com', 'timify.com',
    'booking.com', 'opentable.com', 'quandoo.com', 'resdiary.com', 'squareup.com', 'glossgenius.com',
    'appointy.com', 'acuityscheduling.com', 'as.me', 'zenoti.com', 'phorest.com', 'shedul.com',
    'easyweek.io', 'heygoldie.com', 'appointfix.com', 'mst.link', 'masters-app.ru',
  ],
  MARKETPLACE: [
    'wolt.com', 'foody.com.cy', 'efood.gr', 'ubereats.com', 'deliveroo.com', 'glovoapp.com',
    'bolt.eu', 'just-eat.com', 'etsy.com', 'bazaraki.com', 'airbnb.com', 'vrbo.com',
    'expedia.com', 'hotels.com', 'agoda.com', 'trivago.com',
  ],
  MAPS_LISTING: [
    'google.com', 'goo.gl', 'g.page', 'g.co', 'maps.app.goo.gl', 'business.google.com',
    'yelp.com', 'foursquare.com', 'cyprusyellowpages.com', 'cyprus-yellow-pages.com', 'cylex.com.cy',
    'find-open.com.cy', 'infobel.com',
  ],
};

/**
 * Brands that exist under many country domains (tripadvisor.co.uk, treatwell.gr ...):
 * matched as "<brand>.<tld>" or "<brand>.<second-level>.<tld>".
 */
const PLATFORM_BRANDS: Record<string, PlatformKind> = {
  tripadvisor: 'MAPS_LISTING',
  treatwell: 'BOOKING',
  thefork: 'BOOKING',
  amazon: 'MARKETPLACE',
  ebay: 'MARKETPLACE',
  airbnb: 'MARKETPLACE',
  booking: 'BOOKING',
  yelp: 'MAPS_LISTING',
  google: 'MAPS_LISTING',
  facebook: 'SOCIAL',
  instagram: 'SOCIAL',
};

const HOST_TO_KIND = new Map<string, PlatformKind>(
  (Object.entries(PLATFORM_HOSTS) as [PlatformKind, string[]][]).flatMap(([kind, hosts]) =>
    hosts.map((host) => [host, kind] as const),
  ),
);

const BRAND_PATTERN = new RegExp(
  `(?:^|\\.)(${Object.keys(PLATFORM_BRANDS).join('|')})\\.[a-z]{2,3}(?:\\.[a-z]{2})?$`,
);

/** Platform kind for a lowercase host name, or null for an ordinary website. */
export function platformKindOfHost(host: string): PlatformKind | null {
  const clean = host.toLowerCase().replace(/\.$/, '');
  // Walk up the labels: "n123.alteg.io" -> "alteg.io" -> "io".
  let candidate = clean;
  for (;;) {
    const kind = HOST_TO_KIND.get(candidate);
    if (kind) return kind;
    const dot = candidate.indexOf('.');
    if (dot === -1) break;
    candidate = candidate.slice(dot + 1);
  }
  const brand = BRAND_PATTERN.exec(clean);
  return brand?.[1] ? (PLATFORM_BRANDS[brand[1]] ?? null) : null;
}