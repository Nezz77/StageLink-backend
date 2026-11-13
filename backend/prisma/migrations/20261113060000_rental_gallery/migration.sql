CREATE TABLE rental_gallery_items (
  id uuid PRIMARY KEY,
  listing_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  portfolio_item_id uuid NOT NULL REFERENCES portfolio_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  caption varchar(240) NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  CONSTRAINT rental_gallery_items_listing_id_portfolio_item_id_key UNIQUE (listing_id, portfolio_item_id),
  CONSTRAINT rental_gallery_items_listing_id_owner_id_fkey
    FOREIGN KEY (listing_id, owner_id) REFERENCES rental_listings(id, owner_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX rental_gallery_items_portfolio_item_id_idx ON rental_gallery_items(portfolio_item_id);
