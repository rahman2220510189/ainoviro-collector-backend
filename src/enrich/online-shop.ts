/**
 * Does a business already sell online (step 6.3)? These are the best vendors for a
 * marketplace: they have products, photos and prices, and know how online orders work.
 * Read from the business's OWN website pages that the crawler fetches anyway:
 *  - a shop system in the page (Shopify, WooCommerce, PrestaShop, ...);
 *  - a cart / checkout / "add to cart";
 *  - a link to their shop on a marketplace (Etsy, Amazon, eBay, Skroutz, ...).
 * No marketplace site is visited; only the links on the business's own pages are read.
 */

export interface OnlineSelling {
  sellsOnline: boolean;
  /** What was found, e.g. ["woocommerce", "cart", "skroutz"]. */
  signals: string[];
}

/** Shop systems, recognised by their typical files and markers in the HTML. */
const PLATFORMS: [string, RegExp][] = [
  ['shopify', /cdn\.shopify\.com|shopify\.theme|myshopify\.com/i],
  ['woocommerce', /woocommerce|wc-ajax=|wp-content\/plugins\/woocommerce/i],
  ['magento', /mage\/cookies|magento|static\/version\d+\/frontend/i],
  ['prestashop', /prestashop|\/modules\/ps_shoppingcart/i],
  ['opencart', /index\.php\?route=(checkout|product)\//i],
  ['wix-stores', /wixstores|wix-ecommerce|"ecom-platform"/i],
  [
    'squarespace-commerce',
    /squarespace-commerce|static\.squarespace\.com\/universal\/scripts-compressed\/commerce/i,
  ],
  ['bigcommerce', /cdn\d*\.bigcommerce\.com|bigcommerce/i],
  ['ecwid', /app\.ecwid\.com|ecwid_/i],
  ['shopware', /shopware/i],
];

/** Links to the business's own shop on a marketplace. */
const MARKETPLACES: [string, RegExp][] = [
  ['etsy', /https?:\/\/(?:www\.)?etsy\.com\/(?:[a-z]{2}\/)?shop\//i],
  [
    'amazon',
    /https?:\/\/(?:www\.)?amazon\.(?:com|co\.uk|de|fr|it|es|nl|pl|se|com\.be|ie)\/(?:shops\/|stores\/|s\?(?:[^"' ]*&)?me=|sp\?(?:[^"' ]*&)?seller=)/i,
  ],
  ['ebay', /https?:\/\/(?:www\.)?ebay\.[a-z.]+\/(?:str|usr)\//i],
  ['skroutz', /https?:\/\/(?:www\.)?skroutz\.(?:gr|cy)\/(?:c\/\d+\/[^"' ]*\?shop|m\/|shop\/)/i],
  ['allegro', /https?:\/\/(?:www\.)?allegro\.pl\/(?:uzytkownik|sklep)\//i],
  ['bol', /https?:\/\/(?:www\.)?bol\.com\/[a-z]{2}\/[a-z]{2}\/w\//i],
  ['cdiscount', /https?:\/\/(?:www\.)?cdiscount\.com\/mpv-/i],
  ['aliexpress', /https?:\/\/(?:[a-z]+\.)?aliexpress\.com\/store\//i],
  ['zalando', /https?:\/\/(?:www\.)?zalando\.[a-z.]+\/[^"' ]*-brand/i],
];

/** A cart or checkout the visitor can use (links or buttons, several languages). */
const CART: RegExp[] = [
  /href=["'][^"']*\/(?:cart|basket|checkout|kalathi|warenkorb|panier|carrello|carrito|koszyk)(?:[/?#"']|$)/i,
  /[?&]add-to-cart=\d+/i,
  />\s*(?:add to (?:cart|basket|bag)|buy now|προσθήκη στο καλάθι|in den warenkorb|ajouter au panier|aggiungi al carrello|añadir al carrito)\s*</i,
];

export function detectOnlineSelling(pages: { html: string }[]): OnlineSelling {
  const signals = new Set<string>();
  for (const { html } of pages) {
    for (const [name, re] of PLATFORMS) if (re.test(html)) signals.add(name);
    for (const [name, re] of MARKETPLACES) if (re.test(html)) signals.add(name);
    if (CART.some((re) => re.test(html))) signals.add('cart');
  }
  return { sellsOnline: signals.size > 0, signals: [...signals].sort() };
}
