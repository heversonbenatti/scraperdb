-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.builds (
  id integer NOT NULL DEFAULT nextval('builds_id_seq'::regclass),
  name character varying NOT NULL,
  categories ARRAY NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  auto_refresh boolean DEFAULT true,
  product_overrides jsonb DEFAULT '{}'::jsonb,
  product_quantities jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT builds_pkey PRIMARY KEY (id)
);
CREATE TABLE public.keyword_groups (
  id integer NOT NULL DEFAULT nextval('keyword_groups_id_seq'::regclass),
  search_config_id integer NOT NULL,
  keywords text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT keyword_groups_pkey PRIMARY KEY (id),
  CONSTRAINT keyword_groups_search_config_id_fkey FOREIGN KEY (search_config_id) REFERENCES public.search_configs(id)
);
CREATE TABLE public.prices (
  id integer NOT NULL DEFAULT nextval('prices_id_seq'::regclass),
  product_id integer NOT NULL,
  price numeric NOT NULL,
  collected_at timestamp with time zone DEFAULT now(),
  last_checked_at timestamp with time zone DEFAULT now(),
  price_changed_at timestamp with time zone DEFAULT now(),
  check_count integer DEFAULT 1,
  CONSTRAINT prices_pkey PRIMARY KEY (id),
  CONSTRAINT prices_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id)
);
CREATE TABLE public.product_groups (
  id integer NOT NULL DEFAULT nextval('product_groups_id_seq'::regclass),
  name character varying NOT NULL,
  category character varying NOT NULL,
  subcategory character varying NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT product_groups_pkey PRIMARY KEY (id)
);
CREATE TABLE public.products (
  id integer NOT NULL DEFAULT nextval('products_id_seq'::regclass),
  name character varying NOT NULL,
  website character varying NOT NULL,
  category character varying NOT NULL,
  product_link text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  product_group_id integer,
  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_product_group_id_fkey FOREIGN KEY (product_group_id) REFERENCES public.product_groups(id)
);
CREATE TABLE public.search_configs (
  id integer NOT NULL DEFAULT nextval('search_configs_id_seq'::regclass),
  search_text character varying NOT NULL,
  category character varying NOT NULL,
  website character varying NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT search_configs_pkey PRIMARY KEY (id)
);