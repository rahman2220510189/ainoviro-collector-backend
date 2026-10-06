import { describe, expect, it } from 'vitest';
import { detectOnlineSelling } from '../src/enrich/online-shop';

const page = (html: string) => [{ html }];

describe('detectOnlineSelling (does the business already sell online?)', () => {
  it('recognises shop systems by their files', () => {
    expect(
      detectOnlineSelling(page('<script src="https://cdn.shopify.com/s/files/x.js">')).signals,
    ).toEqual(['shopify']);
    expect(
      detectOnlineSelling(page('<link href="/wp-content/plugins/woocommerce/assets/css/x.css">'))
        .signals,
    ).toEqual(['woocommerce']);
  });

  it('recognises a cart, a checkout or an "add to cart" button, also in Greek', () => {
    expect(detectOnlineSelling(page('<a href="/cart">Cart</a>')).signals).toEqual(['cart']);
    expect(detectOnlineSelling(page('<button>Προσθήκη στο καλάθι</button>')).signals).toEqual([
      'cart',
    ]);
    expect(detectOnlineSelling(page('<a href="/shop/?add-to-cart=42">')).signals).toContain('cart');
  });

  it('recognises links to the business’s own marketplace shop', () => {
    const html =
      '<a href="https://www.etsy.com/shop/CyprusCeramics">Etsy</a>' +
      '<a href="https://www.skroutz.gr/shop/12345/my-shop">Skroutz</a>' +
      '<a href="https://www.ebay.de/str/meinladen">eBay</a>';
    expect(detectOnlineSelling(page(html))).toEqual({
      sellsOnline: true,
      signals: ['ebay', 'etsy', 'skroutz'],
    });
  });

  it('does not count ordinary pages, social links or a marketplace home page', () => {
    const html =
      '<a href="/contact">Contact</a><a href="https://facebook.com/cafe">Facebook</a>' +
      '<a href="https://www.etsy.com/">Etsy</a><p>We sell the best coffee in town.</p>';
    expect(detectOnlineSelling(page(html))).toEqual({ sellsOnline: false, signals: [] });
  });

  it('combines what all pages of the site show', () => {
    const r = detectOnlineSelling([{ html: '<a href="/checkout">' }, { html: 'cdn.shopify.com' }]);
    expect(r.signals).toEqual(['cart', 'shopify']);
  });
});
