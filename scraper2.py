import asyncio
from telegram_bot.telegram_bot import TelegramPriceBot
from urllib.parse import quote_plus
import time
import random
import threading
import signal
import sys
import os
from dotenv import load_dotenv

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
import nest_asyncio

from sqlalchemy import create_engine, Table, Column, Integer, String, Numeric, ForeignKey, MetaData, select, Boolean, DateTime
from datetime import datetime, timedelta

# Permite usar asyncio dentro de notebooks/threads
nest_asyncio.apply()

load_dotenv()

DATABASE_URL = os.getenv('DATABASE_URL')

engine = create_engine(DATABASE_URL, echo=True)
metadata = MetaData()

products = Table("products", metadata,
    Column("id", Integer, primary_key=True),
    Column("name", String, nullable=False),
    Column("website", String, nullable=False),
    Column("category", String, nullable=False),
    Column("product_link", String),
)

prices = Table("prices", metadata,
    Column("id", Integer, primary_key=True),
    Column("product_id", Integer, ForeignKey("products.id"), nullable=False),
    Column("price", Numeric, nullable=False),
    Column("collected_at", DateTime, default=datetime.now),
    Column("last_checked_at", DateTime, default=datetime.now),
    Column("price_changed_at", DateTime, default=datetime.now),
    Column("check_count", Integer, default=1),
)

search_configs = Table("search_configs", metadata,
    Column("id", Integer, primary_key=True),
    Column("search_text", String, nullable=False),
    Column("category", String, nullable=False),
    Column("website", String, nullable=False),
    Column("is_active", Boolean, default=True),
    Column("created_at", DateTime, default=datetime.now),
)

keyword_groups = Table("keyword_groups", metadata,
    Column("id", Integer, primary_key=True),
    Column("search_config_id", Integer, ForeignKey("search_configs.id", ondelete="CASCADE"), nullable=False),
    Column("keywords", String, nullable=False),
    Column("created_at", DateTime, default=datetime.now),
)

TIMEOUT = 15000  # 15 segundos

# Global stop event
stop_event = threading.Event()

def random_delay():
    delay_time = random.uniform(1, 3)
    if stop_event.wait(delay_time):
        return True
    return False

def normalize_price_pichau(price_text):
    """
    Função para normalizar preços da Pichau e evitar problemas de formatação
    """
    try:
        clean_text = price_text.replace("\xa0", " ").replace("R$", "").replace(" ", "").strip()
        
        if "." in clean_text and "," in clean_text:
            clean_text = clean_text.replace(".", "").replace(",", ".")
            price = float(clean_text)
        elif "," in clean_text and "." not in clean_text:
            clean_text = clean_text.replace(",", ".")
            price = float(clean_text)
        elif "." in clean_text and "," not in clean_text:
            parts = clean_text.split(".")
            if len(parts) == 2 and len(parts[1]) > 2:
                price = float(clean_text) / 100
            else:
                price = float(clean_text)
        else:
            price = float(clean_text)
        
        if price > 10000:
            corrected_price = price / 100
            if 10 <= corrected_price <= 10000:
                print(f"⚠️ Preço suspeito corrigido: {price} -> {corrected_price}")
                price = corrected_price
        
        return price
        
    except Exception as e:
        print(f"❌ Erro ao normalizar preço '{price_text}': {e}")
        return 0.0
    
def notify_price_drop_if_needed(product_name, old_price, new_price, website):
    if new_price < old_price:
        try:
            bot = TelegramPriceBot()
            message = f"🚨 QUEDA DE PREÇO!\n\n"
            message += f"📱 {product_name}\n"
            message += f"🏪 {website}\n"
            message += f"💰 De R$ {old_price:.2f} para R$ {new_price:.2f}\n"
            message += f"📉 Economia: R$ {old_price-new_price:.2f}"
            
            asyncio.run(bot.send_message(message))
        except Exception as e:
            print(f"Erro ao enviar notificação: {e}")

def save_product(name, price, website, category, product_link, keywords_matched=None):
    if price > 10.0:
        print(f"\n💾 Tentando salvar: {name} | {website} | {category} | {price} | Matched: {keywords_matched}")

        try:
            with engine.begin() as conn:
                query = select(products.c.id).where(
                    products.c.name == name,
                    products.c.website == website
                )
                product_id = conn.execute(query).scalar()
                
                if product_id is None:
                    result = conn.execute(products.insert().values(
                        name=name,
                        website=website,
                        category=category,
                        product_link=product_link
                    ))
                    product_id = result.inserted_primary_key[0]
                    print(f"👉 Produto novo inserido com id={product_id}")
                
                last_price_query = select(
                    prices.c.price,
                    prices.c.check_count,
                    prices.c.id,
                    prices.c.last_checked_at
                ).where(
                    prices.c.product_id == product_id
                ).order_by(
                    prices.c.last_checked_at.desc()
                ).limit(1)
                
                last_price_result = conn.execute(last_price_query).first()
                current_time = datetime.now()
                
                if last_price_result is None:
                    conn.execute(prices.insert().values(
                        product_id=product_id,
                        price=price,
                        collected_at=current_time,
                        last_checked_at=current_time,
                        price_changed_at=current_time,
                        check_count=1
                    ))
                    print(f"✅ Primeiro preço inserido: R$ {price}")
                    
                else:
                    last_price = float(last_price_result.price)
                    current_price = float(price)
                    
                    last_checked = last_price_result.last_checked_at
                    if last_checked.tzinfo is not None:
                        last_checked = last_checked.replace(tzinfo=None)
                    time_diff = current_time - last_checked
                    is_same_search = time_diff.total_seconds() < 300
                    
                    if abs(last_price - current_price) > 0.01:
                        conn.execute(prices.insert().values(
                            product_id=product_id,
                            price=current_price,
                            collected_at=current_time,
                            last_checked_at=current_time,
                            price_changed_at=current_time,
                            check_count=1
                        ))
                        price_diff = current_price - last_price
                        percentage = (price_diff / last_price) * 100
                        print(f"📈 Preço mudou: R$ {last_price} → R$ {current_price} ({percentage:+.1f}%)")
                        
                        if not is_same_search:
                            notify_price_drop_if_needed(
                                product_name=name,
                                old_price=last_price,
                                new_price=current_price,
                                website=website
                            )
                        else:
                            print(f"💡 Mudança na mesma busca - notificação ignorada")
                        
                    else:
                        current_check_count = last_price_result.check_count or 0
                        new_check_count = current_check_count + 1
                        
                        conn.execute(
                            prices.update()
                            .where(prices.c.id == last_price_result.id)
                            .values(
                                last_checked_at=current_time,
                                check_count=new_check_count
                            )
                        )
                        print(f"🔄 Preço mantido R$ {current_price} (verificação #{new_check_count})")

        except Exception as e:
            print(f"🔥 Erro inesperado no save_product: {e}")
            import traceback
            traceback.print_exc()

def get_search_configs_with_keywords():
    """Get all active search configurations with their keyword groups"""
    try:
        with engine.begin() as conn:
            configs_query = select(
                search_configs.c.id,
                search_configs.c.search_text,
                search_configs.c.category,
                search_configs.c.website
            ).where(search_configs.c.is_active == True)
            
            configs = conn.execute(configs_query).fetchall()
            
            configs_with_keywords = []
            for config in configs:
                keywords_query = select(keyword_groups.c.keywords).where(
                    keyword_groups.c.search_config_id == config.id
                )
                keyword_rows = conn.execute(keywords_query).fetchall()
                
                keyword_groups_list = []
                for row in keyword_rows:
                    keywords_in_group = [k.strip() for k in row.keywords.split(',') if k.strip()]
                    if keywords_in_group:
                        keyword_groups_list.append(keywords_in_group)
                
                if keyword_groups_list:
                    configs_with_keywords.append({
                        "search_text": config.search_text,
                        "keywords": keyword_groups_list,
                        "category": config.category,
                        "website": config.website
                    })
            
            return configs_with_keywords
    except Exception as e:
        print(f"🔥 Error fetching search configurations: {e}")
        return []

async def create_browser_context(playwright):
    """Cria um contexto de navegador com configurações anti-detecção"""
    user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    ]
    
    browser = await playwright.chromium.launch(
        headless=True,
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI'
        ]
    )
    
    context = await browser.new_context(
        user_agent=random.choice(user_agents),
        viewport={'width': 1366, 'height': 768},
        java_script_enabled=True,
        extra_http_headers={
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    )
    
    # Remove webdriver traces
    await context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });
        
        window.chrome = {
            runtime: {},
        };
        
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });
        
        Object.defineProperty(navigator, 'languages', {
            get: () => ['pt-BR', 'pt', 'en'],
        });
        
        delete navigator.__proto__.webdriver;
    """)
    
    return browser, context

async def scrape_kabum(context, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Kabum: {query}")
    base_url = "https://www.kabum.com.br"
    url = f"{base_url}/busca/{quote_plus(query.replace(' ', '-'))}?page_number=1&page_size=100&facet_filters=&sort=most_searched&variant=null&redirect_terms=true"
    
    page = await context.new_page()
    
    try:
        # Estratégia mais robusta para Kabum
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=15000)
        except:
            print("⚠️ Timeout com domcontentloaded, tentando load...")
            try:
                await page.goto(url, wait_until='load', timeout=15000)
            except:
                print("⚠️ Timeout com load, tentando sem wait_until...")
                await page.goto(url, timeout=15000)
        
        # Espera a página estabilizar
        await page.wait_for_timeout(5000)
        
        # Tenta diferentes seletores para produtos Kabum
        selectors_to_try = [
            "article.productCard",
            ".productCard",
            "[data-testid='product-card']",
            ".product-card",
            "article[class*='product']",
            "div[class*='productCard']"
        ]
        
        cards_found = False
        for selector in selectors_to_try:
            try:
                await page.wait_for_selector(selector, timeout=5000)
                cards_found = True
                print(f"✅ Produtos encontrados com seletor: {selector}")
                break
            except:
                continue
        
        if not cards_found:
            print("⚠️ Nenhum seletor de produto funcionou no Kabum, tentando scraping direto...")
        
        await page.wait_for_timeout(3000)
        
        content = await page.content()
        soup = BeautifulSoup(content, "html.parser")
        
        # Tenta diferentes seletores para encontrar os produtos
        cards = []
        for selector in selectors_to_try:
            cards = soup.select(selector)
            if cards:
                print(f"✅ Usando seletor: {selector} ({len(cards)} produtos)")
                break
        
        if not cards:
            print("⚠️ Nenhum produto encontrado no Kabum")
            with open("/tmp/kabum_debug.html", "w", encoding="utf-8") as f:
                f.write(content)
            print("🔍 HTML salvo em /tmp/kabum_debug.html para debug")
            return
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                # Busca nome do produto - diferentes seletores
                name_selectors = [
                    ".nameCard",
                    ".product-name",
                    "h2",
                    "h3", 
                    "[data-testid='product-name']",
                    "span[class*='name']"
                ]
                
                name_elem = None
                for name_sel in name_selectors:
                    name_elem = card.select_one(name_sel)
                    if name_elem:
                        break
                
                if not name_elem:
                    continue
                    
                base_name = name_elem.get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in base_name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    # Busca link do produto
                    link_selectors = [
                        "a.productLink",
                        "a[href*='/produto/']",
                        "a",
                    ]
                    
                    product_link_elem = None
                    for link_sel in link_selectors:
                        product_link_elem = card.select_one(link_sel)
                        if product_link_elem and product_link_elem.get("href"):
                            break
                    
                    if not product_link_elem:
                        continue
                        
                    href = product_link_elem.get("href")
                    if href.startswith("http"):
                        product_link = href
                    else:
                        product_link = base_url + href
                    
                    # Busca ID do produto
                    product_id = product_link_elem.get("data-smarthintproductid")
                    
                    if product_id:
                        final_name = f"{base_name} #{product_id}"
                        
                        import re
                        with engine.begin() as conn:
                            existing_query = select(products.c.id, products.c.name).where(
                                products.c.name == base_name,
                                products.c.website == "kabum"
                            )
                            existing_product = conn.execute(existing_query).first()
                            
                            if existing_product:
                                existing_name = existing_product.name
                                if not re.search(r'#\d+$', existing_name):
                                    conn.execute(
                                        products.update()
                                        .where(products.c.id == existing_product.id)
                                        .values(name=final_name)
                                    )
                                    print(f"🔄 Nome atualizado: '{existing_name}' → '{final_name}'")
                    else:
                        final_name = base_name
                    
                    # Busca preço com múltiplos seletores
                    price_selectors = [
                        '[data-testid="price-value"]',
                        '.priceCard',
                        '.price',
                        '.product-price',
                        'span[class*="price"]',
                        'div[class*="price"]'
                    ]
                    
                    price_elem = None
                    for price_sel in price_selectors:
                        price_elem = card.select_one(price_sel)
                        if price_elem:
                            break
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True)
                        if "R$" in price_text:
                            try:
                                price = float(price_text.split("R$")[1].replace(".", "").replace(",", "."))
                                save_product(final_name, price, "kabum", category, product_link, matched_keywords)
                            except:
                                print(f"⚠️ Erro ao processar preço: {price_text}")
                        else:
                            print(f"⚠️ Formato de preço inesperado: {price_text}")
                    else:
                        print(f"⚠️ Preço não encontrado para: {base_name}")
                    
            except Exception as e:
                print(f"❌ Erro no parsing Kabum: {e}")
                
    except Exception as e:
        print(f"⚠️ Erro ao carregar página Kabum: {e}")
    finally:
        await page.close()

async def scrape_pichau(context, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Pichau: {query}")
    base_url = "https://www.pichau.com.br"
    url = f"{base_url}{query}"
    
    page = await context.new_page()
    
    try:
        # Estratégia mais robusta - tenta diferentes wait_until
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=15000)
        except:
            print("⚠️ Timeout com domcontentloaded, tentando load...")
            await page.goto(url, wait_until='load', timeout=15000)
        
        # Espera a página estabilizar
        await page.wait_for_timeout(5000)
        
        # Tenta diferentes seletores que podem existir
        selectors_to_try = [
            "[data-cy='list-product']",
            ".product-card",
            ".MuiGrid-item",
            "[data-testid='product-card']",
            "a[href*='/produto/']"
        ]
        
        cards_found = False
        for selector in selectors_to_try:
            try:
                await page.wait_for_selector(selector, timeout=5000)
                cards_found = True
                print(f"✅ Produtos encontrados com seletor: {selector}")
                break
            except:
                continue
        
        if not cards_found:
            print("⚠️ Nenhum seletor de produto funcionou, tentando scraping direto...")
        
        await page.wait_for_timeout(3000)
        
        content = await page.content()
        soup = BeautifulSoup(content, "html.parser")
        
        # Tenta diferentes seletores para encontrar os produtos
        cards = []
        for selector in selectors_to_try:
            cards = soup.select(selector)
            if cards:
                print(f"✅ Usando seletor: {selector} ({len(cards)} produtos)")
                break
        
        if not cards:
            print("⚠️ Nenhum produto encontrado com nenhum seletor")
            with open("/tmp/pichau_debug.html", "w", encoding="utf-8") as f:
                f.write(content)
            print("🔍 HTML salvo em /tmp/pichau_debug.html para debug")
            return
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                # Tenta diferentes seletores para o nome
                name_elem = card.select_one("h2") or card.select_one("h3") or card.select_one(".product-name") or card.select_one("[data-testid='product-name']")
                if not name_elem:
                    continue
                    
                name = name_elem.get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    # Busca o link do produto
                    if card.name == 'a':
                        product_link = base_url + card.get("href")
                    else:
                        link_elem = card.select_one("a") or card.find_parent("a")
                        if link_elem:
                            product_link = base_url + link_elem.get("href")
                        else:
                            continue
                    
                    # Tenta diferentes seletores para o preço
                    price_selectors = [
                        "div.mui-12athy2-price_vista",
                        ".price",
                        "[data-testid='price']",
                        ".product-price",
                        ".price-current",
                        "span[class*='price']",
                        "div[class*='price']"
                    ]
                    
                    price_elem = None
                    for price_sel in price_selectors:
                        price_elem = card.select_one(price_sel)
                        if price_elem:
                            break
                    
                    if not price_elem:
                        print(f"⚠️ Preço não encontrado para: {name}")
                        continue
                        
                    price_text = price_elem.get_text(strip=True).replace("\xa0", " ")
                    price = normalize_price_pichau(price_text)
                    
                    if price > 0:
                        save_product(name, price, "pichau", category, product_link, matched_keywords)
                    else:
                        print(f"⚠️ Preço inválido para {name}: {price_text}")
                    
            except Exception as e:
                print(f"❌ Erro no parsing Pichau: {e}")
                
    except Exception as e:
        print(f"⚠️ Erro ao carregar página Pichau: {e}")
    finally:
        await page.close()

async def scrape_terabyte(context, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Terabyte: {query}")
    base_url = "https://www.terabyteshop.com.br"
    url = f"{base_url}/busca?str={quote_plus(query)}"
    
    page = await context.new_page()
    
    try:
        # Estratégia mais robusta para Terabyte
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=15000)
        except:
            print("⚠️ Timeout com domcontentloaded, tentando load...")
            await page.goto(url, wait_until='load', timeout=15000)
        
        # Espera a página estabilizar
        await page.wait_for_timeout(5000)
        
        # Tenta diferentes seletores
        selectors_to_try = [
            ".product-item",
            ".product-card", 
            ".product",
            "[data-product]",
            "article[class*='product']"
        ]
        
        cards_found = False
        for selector in selectors_to_try:
            try:
                await page.wait_for_selector(selector, timeout=5000)
                cards_found = True
                print(f"✅ Produtos encontrados com seletor: {selector}")
                break
            except:
                continue
        
        if not cards_found:
            print("⚠️ Nenhum seletor de produto funcionou no Terabyte")
        
        content = await page.content()
        soup = BeautifulSoup(content, "html.parser")
        
        # Tenta diferentes seletores para produtos
        cards = []
        for selector in selectors_to_try:
            cards = soup.select(selector)
            if cards:
                print(f"✅ Usando seletor: {selector} ({len(cards)} produtos)")
                break
        
        if not cards:
            print("⚠️ Nenhum produto encontrado no Terabyte")
            with open("/tmp/terabyte_debug.html", "w", encoding="utf-8") as f:
                f.write(content)
            print("🔍 HTML salvo em /tmp/terabyte_debug.html para debug")
            return
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                # Busca nome do produto
                name_elem = card.select_one("h2") or card.select_one("h3") or card.select_one(".product-name") or card.select_one("[data-product-name]")
                if not name_elem:
                    continue
                    
                name = name_elem.get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    # Busca link do produto
                    link_elem = card.select_one("a.product-item__image") or card.select_one("a") or card.find_parent("a")
                    if not link_elem:
                        continue
                        
                    href = link_elem.get("href")
                    if href.startswith("http"):
                        product_link = href
                    else:
                        product_link = base_url + href
                    
                    # Busca preço
                    price_selectors = [
                        ".product-item__new-price span",
                        ".price-current",
                        ".product-price", 
                        ".price",
                        "span[class*='price']"
                    ]
                    
                    price_elem = None
                    for price_sel in price_selectors:
                        price_elem = card.select_one(price_sel)
                        if price_elem:
                            break
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True)
                        price = float(price_text.replace("R$", "").replace(".", "").replace(",", ".").strip())
                        save_product(name, price, "terabyteshop", category, product_link, matched_keywords)
                    else:
                        print(f"⚠️ Preço não encontrado para: {name}")
                    
            except Exception as e:
                print(f"❌ Erro no parsing Terabyte: {e}")
                
    except Exception as e:
        print(f"⚠️ Erro ao carregar página Terabyte: {e}")
    finally:
        await page.close()

async def process_website_async(website_name, searches):
    """Processa todas as buscas de um website usando um único contexto"""
    async with async_playwright() as p:
        browser, context = await create_browser_context(p)
        
        try:
            for search in searches:
                if stop_event.is_set():
                    break
                    
                try:
                    if website_name == "kabum":
                        await scrape_kabum(context, search["search_text"], 
                                         search["keywords"], search["category"])
                    elif website_name == "pichau":
                        await scrape_pichau(context, search["search_text"], 
                                          search["keywords"], search["category"])
                    elif website_name == "terabyte":
                        await scrape_terabyte(context, search["search_text"], 
                                            search["keywords"], search["category"])
                    
                    if stop_event.is_set():
                        break
                        
                    # Delay entre buscas no mesmo site
                    await asyncio.sleep(random.uniform(1, 3))
                    
                except Exception as e:
                    print(f"🔥 Error during {website_name} search: {e}")
                    
        finally:
            await context.close()
            await browser.close()

def process_website(website_name, searches):
    """Wrapper síncrono para o processamento assíncrono"""
    try:
        # Cria novo loop para este thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(process_website_async(website_name, searches))
    except Exception as e:
        print(f"🔥 Error in async processing for {website_name}: {e}")
    finally:
        loop.close()

def start_search():
    def search_task():
        try:
            while not stop_event.is_set():
                print("\n=== Starting new scan ===")
                start_time = time.time()
                
                if stop_event.is_set():
                    break
                
                try:
                    all_searches = get_search_configs_with_keywords()
                    
                    if not all_searches:
                        print("⚠️ No active search configurations found")
                        elapsed = time.time() - start_time
                        delay = max(360 - elapsed, 60)
                        print(f"\n⏳ Next scan in {delay//60} minutes...")
                        
                        if stop_event.wait(delay):
                            break
                        continue
                    
                    searches_by_website = {
                        "kabum": [],
                        "pichau": [],
                        "terabyte": []
                    }
                    
                    for search in all_searches:
                        website = search['website']
                        if website in searches_by_website:
                            searches_by_website[website].append(search)
                    
                    threads = []
                    for website, searches in searches_by_website.items():
                        if searches and not stop_event.is_set():
                            t = threading.Thread(
                                target=process_website,
                                args=(website, searches),
                                daemon=True
                            )
                            threads.append(t)
                            t.start()
                            
                            if stop_event.wait(random.uniform(0.5, 1.5)):
                                break
                    
                    for t in threads:
                        while t.is_alive() and not stop_event.is_set():
                            t.join(timeout=1)
                        
                        if stop_event.is_set():
                            break
                
                except Exception as e:
                    print(f"🔥 Error in search cycle: {e}")
                
                if stop_event.is_set():
                    break
                    
                elapsed = time.time() - start_time
                delay = max(360 - elapsed, 60)
                print(f"\n⏳ Next scan in {delay//60} minutes...")
                
                if stop_event.wait(delay):
                    break
                    
        except Exception as e:
            print(f"Unexpected error in search task: {e}")
        finally:
            print("🛑 Search task stopped")

    search_thread = threading.Thread(target=search_task, daemon=True)
    search_thread.start()
    return search_thread

def signal_handler(sig, frame):
    print("\n🛑 Received shutdown signal, stopping gracefully...")
    stop_event.set()

if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("🚀 Starting PC Scraper with Playwright...")
    print("Press Ctrl+C to stop gracefully")
    
    search_thread = start_search()
    
    try:
        while not stop_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n🛑 Keyboard interrupt received")
        stop_event.set()
    finally:
        print("⏳ Waiting for threads to finish...")
        
        if search_thread.is_alive():
            search_thread.join(timeout=10)
        
        print("✅ Clean shutdown complete.")
        sys.exit(0)