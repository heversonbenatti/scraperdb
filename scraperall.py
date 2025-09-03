import asyncio
import time
import random
import threading
import signal
import sys
import os
import subprocess
import shutil
from urllib.parse import quote_plus
from contextlib import contextmanager
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager

from telegram_bot.telegram_bot import TelegramPriceBot
from dotenv import load_dotenv
from sqlalchemy import create_engine, Table, Column, Integer, String, Numeric, ForeignKey, MetaData, select, Boolean, DateTime
from datetime import datetime
import re

load_dotenv()

DATABASE_URL = os.getenv('DATABASE_URL')
brasilia = ZoneInfo("America/Sao_Paulo")

engine = create_engine(DATABASE_URL, echo=False)
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
    Column("collected_at", DateTime, default=lambda: datetime.now(brasilia)),
    Column("last_checked_at", DateTime, default=lambda: datetime.now(brasilia)),
    Column("price_changed_at", DateTime, default=lambda: datetime.now(brasilia)),
    Column("check_count", Integer, default=1),
)

search_configs = Table("search_configs", metadata,
    Column("id", Integer, primary_key=True),
    Column("search_text", String, nullable=False),
    Column("category", String, nullable=False),
    Column("website", String, nullable=False),
    Column("is_active", Boolean, default=True),
    Column("created_at", DateTime, default=lambda: datetime.now(brasilia)),
)

keyword_groups = Table("keyword_groups", metadata,
    Column("id", Integer, primary_key=True),
    Column("search_config_id", Integer, ForeignKey("search_configs.id", ondelete="CASCADE"), nullable=False),
    Column("keywords", String, nullable=False),
    Column("created_at", DateTime, default=lambda: datetime.now(brasilia)),
)

TIMEOUT = 25

# Global variables
stop_event = threading.Event()
is_windows = sys.platform.startswith('win')

@contextmanager
def managed_driver(website=None):
    """Context manager for driver with proper cleanup and crash recovery"""
    driver = None
    try:
        driver = create_driver(website)
        if not driver:
            raise Exception(f"Failed to create driver for {website}")
        yield driver
    except Exception as e:
        print(f"❌ Erro no driver: {e}")
        raise
    finally:
        if driver:
            try:
                driver.quit()
            except Exception as e:
                print(f"⚠️ Erro ao finalizar driver: {e}")
            finally:
                cleanup_browser_processes()

def cleanup_browser_processes():
    """Force cleanup of Chrome processes"""
    if not is_windows:
        try:
            commands = [
                ['pkill', '-f', 'chrome'],
                ['pkill', '-f', 'chromedriver']
            ]
            
            for cmd in commands:
                subprocess.run(cmd, timeout=3, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        except Exception:
            pass

def random_delay():
    """Interruptible random delay"""
    delay_time = random.uniform(1, 3)
    return stop_event.wait(delay_time)

def normalize_price_pichau(price_text):
    """Normalize Pichau price formatting"""
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
                price = corrected_price
        
        return price
        
    except Exception as e:
        print(f"Erro ao normalizar preço '{price_text}': {e}")
        return 0.0

def calculate_weighted_average(product_id):
    """Calculate historical weighted average excluding current price"""
    try:
        with engine.begin() as conn:
            query = select(
                prices.c.price,
                prices.c.check_count,
                prices.c.price_changed_at
            ).where(
                prices.c.product_id == product_id
            ).order_by(prices.c.price_changed_at.desc())
            
            all_prices = conn.execute(query).fetchall()
            
            if len(all_prices) <= 1:
                return None
            
            historical_prices = all_prices[1:]
            
            if not historical_prices:
                return None
            
            total_weight = sum(max(1, p.check_count or 1) for p in historical_prices)
            weighted_sum = sum(float(p.price) * max(1, p.check_count or 1) for p in historical_prices)
            
            return weighted_sum / total_weight if total_weight > 0 else None
                
    except Exception as e:
        print(f"Erro ao calcular média histórica: {e}")
        return None

def check_promotion_and_notify(product_id, product_name, current_price, website):
    """Check for real promotions and notify"""
    try:
        weighted_average = calculate_weighted_average(product_id)
        
        if not weighted_average or weighted_average == current_price:
            return False
        
        discount_percent = ((weighted_average - current_price) / weighted_average) * 100
        
        is_significant_discount = discount_percent >= 10
        has_minimum_price = current_price >= 20
        is_reasonable_discount = discount_percent <= 80
        discount_amount = weighted_average - current_price
        
        is_promotion = (is_significant_discount and 
                       has_minimum_price and 
                       is_reasonable_discount and 
                       discount_amount > 0)
        
        if is_promotion:
            try:
                bot = TelegramPriceBot()
                message = f"🚨 PROMOÇÃO REAL DETECTADA\n\n"
                message += f"Produto: {product_name}\n"
                message += f"Site: {website.upper()}\n\n"
                message += f"Preço atual: R$ {current_price:.2f}\n"
                message += f"Média histórica: R$ {weighted_average:.2f}\n"
                message += f"Desconto: {discount_percent:.1f}%\n"
                message += f"Economia: R$ {discount_amount:.2f}"
                
                asyncio.run(bot.send_message(message))
                return True
            except Exception as e:
                print(f"❌ Erro ao enviar notificação: {e}")
        
        return False
        
    except Exception as e:
        print(f"❌ Erro ao verificar promoção: {e}")
        return False

def save_product(name, price, website, category, product_link, keywords_matched=None):
    """Save product with optimized duplicate checking and availability tracking"""
    if price <= 10.0:
        return
    
    try:
        with engine.begin() as conn:
            # Check if product exists
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
                print(f"✅ Novo produto criado: {name} (ID: {product_id})")
            
            # Call availability function to mark as available
            conn.execute(select("SELECT mark_product_available(%s, %s, %s)"), (product_id, price, website))
            
            # Get last price
            last_price_query = select(
                prices.c.price,
                prices.c.check_count,
                prices.c.id,
                prices.c.last_checked_at,
                prices.c.price_found
            ).where(
                prices.c.product_id == product_id,
                prices.c.price_found == True  # Only consider valid prices
            ).order_by(
                prices.c.last_checked_at.desc()
            ).limit(1)
            
            last_price_result = conn.execute(last_price_query).first()
            current_time = datetime.now(brasilia)
            
            if last_price_result is None:
                # First price for this product
                conn.execute(prices.insert().values(
                    product_id=product_id,
                    price=price,
                    price_found=True,
                    scrape_attempt_at=current_time,
                    collected_at=current_time,
                    last_checked_at=current_time,
                    price_changed_at=current_time,
                    check_count=1
                ))
                print(f"💰 Primeiro preço salvo: R$ {price:.2f} para {name}")
            else:
                last_price = float(last_price_result.price)
                current_price = float(price)
                
                if abs(last_price - current_price) > 0.01:
                    # Price changed - insert new record
                    conn.execute(prices.insert().values(
                        product_id=product_id,
                        price=current_price,
                        price_found=True,
                        scrape_attempt_at=current_time,
                        collected_at=current_time,
                        last_checked_at=current_time,
                        price_changed_at=current_time,
                        check_count=1
                    ))
                    
                    print(f"📈 Preço alterado: R$ {last_price:.2f} → R$ {current_price:.2f} ({name})")
                    check_promotion_and_notify(product_id, name, current_price, website)
                else:
                    # Same price - update counters
                    current_check_count = last_price_result.check_count or 0
                    new_check_count = current_check_count + 1
                    
                    conn.execute(
                        prices.update()
                        .where(prices.c.id == last_price_result.id)
                        .values(
                            last_checked_at=current_time,
                            check_count=new_check_count,
                            scrape_attempt_at=current_time
                        )
                    )
                    print(f"✅ Preço confirmado: R$ {current_price:.2f} (check #{new_check_count}) - {name}")

    except Exception as e:
        print(f"❌ Erro ao salvar produto: {e}")

def mark_product_unavailable(product_name, website, category):
    """Mark a product as unavailable when price is not found"""
    try:
        with engine.begin() as conn:
            # Find product by name and website
            query = select(products.c.id, products.c.name).where(
                products.c.name == product_name,
                products.c.website == website
            )
            product_result = conn.execute(query).first()
            
            if product_result:
                product_id = product_result.id
                # Call database function to mark as unavailable
                conn.execute(select("SELECT mark_product_unavailable(%s, %s)"), (product_id, website))
                print(f"⚠️ Produto indisponível: {product_name}")
            else:
                print(f"❓ Produto não encontrado no BD para marcar como indisponível: {product_name}")
                
    except Exception as e:
        print(f"❌ Erro ao marcar produto como indisponível: {e}")

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
        print(f"❌ Erro ao buscar configurações: {e}")
        return []

def scrape_kabum(driver, wait, query, wordlist, category):
    """Scrape Kabum with error handling and availability tracking"""
    if stop_event.is_set():
        return 0, 0
    
    print(f"\nBuscando {query} em: KABUM")
    products_found = 0
    products_saved = 0
    products_unavailable = 0
    
    # Track products that should exist but weren't found
    existing_products = set()
    try:
        with engine.begin() as conn:
            existing_query = select(products.c.name).where(
                products.c.website == "kabum",
                products.c.category == category,
                products.c.is_available == True
            )
            existing_result = conn.execute(existing_query).fetchall()
            existing_products = {row.name for row in existing_result}
    except Exception as e:
        print(f"⚠️ Erro ao buscar produtos existentes: {e}")
    
    found_products = set()
    
    try:
        base_url = "https://www.kabum.com.br"
        url = f"{base_url}/busca/{quote_plus(query.replace(' ', '-'))}?page_number=1&page_size=100&facet_filters=&sort=most_searched&variant=null&redirect_terms=true"
        
        driver.get(url)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "article.productCard")))
        
        soup = BeautifulSoup(driver.page_source, "html.parser")
        cards = soup.select("article.productCard")
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                base_name = card.select_one(".nameCard").get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in base_name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    products_found += 1
                    
                    product_link_elem = card.select_one("a.productLink")
                    product_link = base_url + product_link_elem.get("href")
                    product_id = product_link_elem.get("data-smarthintproductid")
                    
                    final_name = f"{base_name} #{product_id}" if product_id else base_name
                    found_products.add(final_name)
                    
                    # Update existing products without ID
                    if product_id:
                        with engine.begin() as conn:
                            existing_query = select(products.c.id, products.c.name).where(
                                products.c.name == base_name,
                                products.c.website == "kabum"
                            )
                            existing_product = conn.execute(existing_query).first()
                            
                            if existing_product and not re.search(r'#\d+
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Kabum: {e}")
        
        # Check for products that existed but weren't found in this scrape
        missing_products = existing_products - found_products
        for missing_product in missing_products:
            if len(missing_products) <= 10:  # Only log if reasonable number
                print(f"🔍 Produto não encontrado na busca: {missing_product}")
            mark_product_unavailable(missing_product, "kabum", category)
            products_unavailable += 1
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    print(f"📊 KABUM - Encontrados: {products_found} | Salvos: {products_saved} | Indisponíveis: {products_unavailable}")
    
    return products_found, products_saved

def scrape_pichau(driver, wait, query, wordlist, category):
    """Scrape Pichau with enhanced price parsing and availability tracking"""
    if stop_event.is_set():
        return 0, 0
    
    print(f"\nBuscando {query} em: PICHAU")
    products_found = 0
    products_saved = 0
    products_unavailable = 0
    
    # Track products that should exist but weren't found
    existing_products = set()
    try:
        with engine.begin() as conn:
            existing_query = select(products.c.name).where(
                products.c.website == "pichau",
                products.c.category == category,
                products.c.is_available == True
            )
            existing_result = conn.execute(existing_query).fetchall()
            existing_products = {row.name for row in existing_result}
    except Exception as e:
        print(f"⚠️ Erro ao buscar produtos existentes: {e}")
    
    found_products = set()
    
    try:
        base_url = "https://www.pichau.com.br"
        url = f"{base_url}{query}"
        
        driver.get(url)
        time.sleep(3)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-cy='list-product']")))
        time.sleep(2)
        
        soup = BeautifulSoup(driver.page_source, "html.parser")
        cards = soup.select("[data-cy='list-product']")
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                name = card.select_one("h2").get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    products_found += 1
                    
                    product_link = base_url + card.get("href")
                    found_products.add(name)
                    
                    price_elem = card.select_one("div.mui-12athy2-price_vista, .price, [data-testid='price']")
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True).replace("\xa0", " ")
                        try:
                            price = normalize_price_pichau(price_text)
                            
                            if price > 10.0:
                                save_product(name, price, "pichau", category, product_link, matched_keywords)
                                products_saved += 1
                            else:
                                print(f"⚠️ Preço muito baixo ignorado: R$ {price:.2f} - {name}")
                        except Exception as pe:
                            print(f"❌ Erro ao processar preço '{price_text}': {pe}")
                            mark_product_unavailable(name, "pichau", category)
                            products_unavailable += 1
                    else:
                        print(f"❌ Preço não encontrado para: {name}")
                        mark_product_unavailable(name, "pichau", category)
                        products_unavailable += 1
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Pichau: {e}")
        
        # Check for products that existed but weren't found in this scrape
        missing_products = existing_products - found_products
        for missing_product in missing_products:
            if len(missing_products) <= 10:  # Only log if reasonable number
                print(f"🔍 Produto não encontrado na busca: {missing_product}")
            mark_product_unavailable(missing_product, "pichau", category)
            products_unavailable += 1
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    print(f"📊 PICHAU - Encontrados: {products_found} | Salvos: {products_saved} | Indisponíveis: {products_unavailable}")
    
    return products_found, products_saved

def scrape_terabyte(driver, wait, query, wordlist, category):
    """Scrape Terabyte with error handling and availability tracking"""
    if stop_event.is_set():
        return 0, 0
    
    print(f"\nBuscando {query} em: TERABYTE")
    products_found = 0
    products_saved = 0
    products_unavailable = 0
    
    # Track products that should exist but weren't found
    existing_products = set()
    try:
        with engine.begin() as conn:
            existing_query = select(products.c.name).where(
                products.c.website == "terabyteshop",
                products.c.category == category,
                products.c.is_available == True
            )
            existing_result = conn.execute(existing_query).fetchall()
            existing_products = {row.name for row in existing_result}
    except Exception as e:
        print(f"⚠️ Erro ao buscar produtos existentes: {e}")
    
    found_products = set()
    
    try:
        base_url = "https://www.terabyteshop.com.br"
        url = f"{base_url}/busca?str={quote_plus(query)}"
        
        driver.get(url)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".product-item")))
        
        soup = BeautifulSoup(driver.page_source, "html.parser")
        cards = soup.select(".product-item")
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                name = card.select_one("h2").get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    products_found += 1
                    
                    product_link = card.select_one("a.product-item__image").get("href")
                    found_products.add(name)
                    
                    price_elem = card.select_one(".product-item__new-price span")
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True)
                        try:
                            price = float(price_text.replace("R$", "").replace(".", "").replace(",", ".").strip())
                            
                            if price > 10.0:
                                save_product(name, price, "terabyteshop", category, product_link, matched_keywords)
                                products_saved += 1
                            else:
                                print(f"⚠️ Preço muito baixo ignorado: R$ {price:.2f} - {name}")
                        except Exception as pe:
                            print(f"❌ Erro ao processar preço '{price_text}': {pe}")
                            mark_product_unavailable(name, "terabyteshop", category)
                            products_unavailable += 1
                    else:
                        print(f"❌ Preço não encontrado para: {name}")
                        mark_product_unavailable(name, "terabyteshop", category)
                        products_unavailable += 1
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Terabyte: {e}")
        
        # Check for products that existed but weren't found in this scrape
        missing_products = existing_products - found_products
        for missing_product in missing_products:
            if len(missing_products) <= 10:  # Only log if reasonable number
                print(f"🔍 Produto não encontrado na busca: {missing_product}")
            mark_product_unavailable(missing_product, "terabyteshop", category)
            products_unavailable += 1
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    print(f"📊 TERABYTE - Encontrados: {products_found} | Salvos: {products_saved} | Indisponíveis: {products_unavailable}")
    
    return products_found, products_saved

def get_chromedriver_path():
    """Get ChromeDriver path with robust error handling"""
    if not is_windows:
        return "/usr/local/bin/chromedriver"
    
    try:
        # First attempt: use webdriver-manager
        print("🔄 Baixando/verificando ChromeDriver...")
        driver_path = ChromeDriverManager().install()
        
        # Validate the path is an executable
        if os.path.exists(driver_path) and driver_path.endswith('.exe'):
            print(f"✅ ChromeDriver encontrado: {driver_path}")
            return driver_path
            
        # If path doesn't end with .exe, search for the actual executable
        print("⚠️ Procurando executável do ChromeDriver...")
        driver_dir = os.path.dirname(driver_path)
        for file in os.listdir(driver_dir):
            if file.endswith('.exe') and 'chromedriver' in file.lower():
                exe_path = os.path.join(driver_dir, file)
                if os.path.exists(exe_path):
                    print(f"✅ ChromeDriver executável encontrado: {exe_path}")
                    return exe_path
        
        # If still no valid path, clear cache and try again
        print("🔄 ChromeDriver inválido, limpando cache...")
        cache_dir = os.path.expanduser('~/.wdm')
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
            print("✅ Cache limpo")
            
        # Retry after cache clear
        print("🔄 Reinstalando ChromeDriver...")
        driver_path = ChromeDriverManager().install()
        
        if driver_path.endswith('.exe'):
            print(f"✅ ChromeDriver reinstalado: {driver_path}")
            return driver_path
            
        # Last attempt: find any chromedriver.exe in the directory
        driver_dir = os.path.dirname(driver_path)
        for file in os.listdir(driver_dir):
            if file == 'chromedriver.exe':
                exe_path = os.path.join(driver_dir, file)
                print(f"✅ ChromeDriver encontrado: {exe_path}")
                return exe_path
                
        raise Exception("ChromeDriver executável não encontrado")
        
    except Exception as e:
        raise Exception(f"Falha ao configurar ChromeDriver: {e}. Verifique se o Chrome está instalado.")

def create_driver(website=None):
    """Create optimized Chrome driver with robust error handling"""
    try:
        # Get ChromeDriver path
        driver_path = get_chromedriver_path()
        service = Service(driver_path)
        
        options = ChromeOptions()
        
        # Common Chrome options for performance and stealth
        options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--disable-extensions")
        options.add_argument("--disable-plugins")
        options.add_argument("--disable-images")
        options.add_argument("--disable-web-security")
        options.add_argument("--allow-running-insecure-content")
        options.add_argument("--ignore-certificate-errors")
        options.add_argument("--disable-background-timer-throttling")
        options.add_argument("--disable-backgrounding-occluded-windows")
        options.add_argument("--disable-renderer-backgrounding")
        options.add_argument("--disable-features=TranslateUI")
        options.add_argument("--disable-ipc-flooding-protection")
        
        # Memory optimization
        options.add_argument("--memory-pressure-off")
        options.add_argument("--max_old_space_size=2048")
        options.add_argument("--aggressive-cache-discard")
        
        # User agent rotation
        user_agents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        ]
        options.add_argument(f"--user-agent={random.choice(user_agents)}")
        
        # Anti-detection
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option('useAutomationExtension', False)
        options.add_argument("--disable-blink-features=AutomationControlled")
        
        driver = webdriver.Chrome(service=service, options=options)
        
        # Optimized timeouts
        driver.set_page_load_timeout(30)
        driver.implicitly_wait(10)
        
        # Hide webdriver property
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        
        return driver
        
    except Exception as e:
        print(f"❌ Erro ao criar driver Chrome: {e}")
        return None

def process_search(website, search_config):
    """Process a single search with proper error handling"""
    if stop_event.is_set():
        return 0, 0
    
    try:
        with managed_driver(website) as driver:
            wait = WebDriverWait(driver, TIMEOUT)
            
            if website == "kabum":
                found, saved = scrape_kabum(driver, wait, search_config["search_text"], 
                                          search_config["keywords"], search_config["category"])
            elif website == "pichau":
                found, saved = scrape_pichau(driver, wait, search_config["search_text"], 
                                           search_config["keywords"], search_config["category"])
            elif website == "terabyte":
                found, saved = scrape_terabyte(driver, wait, search_config["search_text"], 
                                             search_config["keywords"], search_config["category"])
            else:
                return 0, 0
            
            return found, saved
            
    except Exception as e:
        print(f"❌ Erro na busca '{search_config['search_text']}' em {website}: {e}")
        return 0, 0

def start_search():
    """Main search loop with optimized error handling"""
    def search_task():
        scan_count = 0
        
        try:
            while not stop_event.is_set():
                scan_count += 1
                print(f"\n{'='*50}")
                print(f"   INICIANDO SCAN #{scan_count}")
                print(f"{'='*50}")
                
                start_time = time.time()
                total_found = 0
                total_saved = 0
                total_searches = 0
                
                try:
                    all_searches = get_search_configs_with_keywords()
                    
                    if not all_searches:
                        print("❌ Nenhuma configuração de busca ativa")
                        if stop_event.wait(300):  # 5 minutes
                            break
                        continue
                    
                    # Organize by website (kabum, terabyte e pichau)
                    searches_by_website = {"kabum": [], "terabyte": [], "pichau": []}
                    
                    for search in all_searches:
                        website = search['website']
                        if website in searches_by_website:
                            searches_by_website[website].append(search)
                    
                    # Process each website sequentially for stability
                    for website, searches in searches_by_website.items():
                        if not searches or stop_event.is_set():
                            continue
                        
                        print(f"\n🔍 {website.upper()}: {len(searches)} buscas")
                        website_found = 0
                        website_saved = 0
                        
                        for search in searches:
                            if stop_event.is_set():
                                break
                            
                            found, saved = process_search(website, search)
                            website_found += found
                            website_saved += saved
                            total_searches += 1
                            
                            # Small delay between searches
                            if random_delay():
                                break
                        
                        total_found += website_found
                        total_saved += website_saved
                        
                        print(f"✅ {website.upper()}: {website_found} encontrados, {website_saved} salvos")
                        
                        # Delay between websites
                        if stop_event.wait(random.uniform(2, 4)):
                            break
                    
                except Exception as e:
                    print(f"❌ Erro no ciclo de busca: {e}")
                
                # Final summary
                elapsed = time.time() - start_time
                print(f"\n📊 RESUMO SCAN #{scan_count}:")
                print(f"   Tempo: {elapsed:.1f}s")
                print(f"   Buscas: {total_searches}")
                print(f"   Produtos encontrados: {total_found}")
                print(f"   Produtos salvos: {total_saved}")
                
                if total_found > 0:
                    success_rate = (total_saved / total_found) * 100
                    print(f"   Taxa de sucesso: {success_rate:.1f}%")
                
                if stop_event.is_set():
                    break
                
                # Wait for next scan
                delay = max(360 - elapsed, 60)
                print(f"\n⏳ Próximo scan em {delay//60} minutos...")
                
                if stop_event.wait(delay):
                    break
                    
        except Exception as e:
            print(f"❌ Erro crítico: {e}")
        finally:
            print("🛑 Search task finalizada")

    search_thread = threading.Thread(target=search_task, daemon=True)
    search_thread.start()
    return search_thread

def signal_handler(sig, frame):
    """Handle shutdown signals gracefully"""
    print("\n🛑 Parando graciosamente...")
    stop_event.set()
    cleanup_browser_processes()

if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("🚀 Iniciando PC Scraper v3.0 - Full Chrome Edition")
    print(f"Sistema: {'Windows' if is_windows else 'Linux'} | Driver: Chrome")
    print("Pressione Ctrl+C para parar")
    
    # Initial cleanup
    cleanup_browser_processes()
    
    search_thread = start_search()
    
    try:
        while not stop_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n⌨️ Interrupção do teclado")
        stop_event.set()
    finally:
        print("🔄 Finalizando threads...")
        
        cleanup_browser_processes()
        
        if search_thread.is_alive():
            search_thread.join(timeout=10)
        
        cleanup_browser_processes()
        print("✅ Finalização completa")
        sys.exit(0)
, existing_product.name):
                                conn.execute(
                                    products.update()
                                    .where(products.c.id == existing_product.id)
                                    .values(name=final_name)
                                )
                    
                    price_elem = card.select_one('[data-testid="price-value"], .priceCard')
                    if price_elem:
                        price_text = price_elem.get_text(strip=True)
                        try:
                            price = float(price_text.split("R$")[1].replace(".", "").replace(",", "."))
                            
                            if price > 10.0:
                                save_product(final_name, price, "kabum", category, product_link, matched_keywords)
                                products_saved += 1
                            else:
                                print(f"⚠️ Preço muito baixo ignorado: R$ {price:.2f} - {final_name}")
                        except (ValueError, IndexError) as pe:
                            print(f"❌ Erro ao processar preço '{price_text}': {pe}")
                            mark_product_unavailable(final_name, "kabum", category)
                            products_unavailable += 1
                    else:
                        print(f"❌ Preço não encontrado para: {final_name}")
                        mark_product_unavailable(final_name, "kabum", category)
                        products_unavailable += 1
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Kabum: {e}")
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    if products_found > 0:
        print(f"{products_found} produtos encontrados e {products_saved} salvos")
    else:
        print("Nenhum produto encontrado")
    
    return products_found, products_saved

def scrape_pichau(driver, wait, query, wordlist, category):
    """Scrape Pichau with enhanced price parsing"""
    if stop_event.is_set():
        return 0, 0
    
    print(f"\nBuscando {query} em: PICHAU")
    products_found = 0
    products_saved = 0
    
    try:
        base_url = "https://www.pichau.com.br"
        url = f"{base_url}{query}"
        
        driver.get(url)
        time.sleep(3)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-cy='list-product']")))
        time.sleep(2)
        
        soup = BeautifulSoup(driver.page_source, "html.parser")
        cards = soup.select("[data-cy='list-product']")
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                name = card.select_one("h2").get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    products_found += 1
                    
                    product_link = base_url + card.get("href")
                    price_elem = card.select_one("div.mui-12athy2-price_vista, .price, [data-testid='price']")
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True).replace("\xa0", " ")
                        price = normalize_price_pichau(price_text)
                        
                        if price > 10.0:
                            save_product(name, price, "pichau", category, product_link, matched_keywords)
                            products_saved += 1
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Pichau: {e}")
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    if products_found > 0:
        print(f"{products_found} produtos encontrados e {products_saved} salvos")
    else:
        print("Nenhum produto encontrado")
    
    return products_found, products_saved

def scrape_terabyte(driver, wait, query, wordlist, category):
    """Scrape Terabyte with error handling"""
    if stop_event.is_set():
        return 0, 0
    
    print(f"\nBuscando {query} em: TERABYTE")
    products_found = 0
    products_saved = 0
    
    try:
        base_url = "https://www.terabyteshop.com.br"
        url = f"{base_url}/busca?str={quote_plus(query)}"
        
        driver.get(url)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".product-item")))
        
        soup = BeautifulSoup(driver.page_source, "html.parser")
        cards = soup.select(".product-item")
        
        for card in cards:
            if stop_event.is_set():
                break
                
            try:
                name = card.select_one("h2").get_text(strip=True).lower()
                matched_keywords = []
                for words in wordlist:
                    if all(p.lower() in name for p in words):
                        matched_keywords.append(words)
                
                if matched_keywords:
                    products_found += 1
                    
                    product_link = card.select_one("a.product-item__image").get("href")
                    price_elem = card.select_one(".product-item__new-price span")
                    
                    if price_elem:
                        price_text = price_elem.get_text(strip=True)
                        price = float(price_text.replace("R$", "").replace(".", "").replace(",", ".").strip())
                        
                        if price > 10.0:
                            save_product(name, price, "terabyteshop", category, product_link, matched_keywords)
                            products_saved += 1
                    
            except Exception as e:
                print(f"❌ Erro parsing produto Terabyte: {e}")
                
    except Exception as e:
        print(f"❌ Erro: {e}")
        return 0, 0
    
    if products_found > 0:
        print(f"{products_found} produtos encontrados e {products_saved} salvos")
    else:
        print("Nenhum produto encontrado")
    
    return products_found, products_saved

def get_chromedriver_path():
    """Get ChromeDriver path with robust error handling"""
    if not is_windows:
        return "/usr/local/bin/chromedriver"
    
    try:
        # First attempt: use webdriver-manager
        print("🔄 Baixando/verificando ChromeDriver...")
        driver_path = ChromeDriverManager().install()
        
        # Validate the path is an executable
        if os.path.exists(driver_path) and driver_path.endswith('.exe'):
            print(f"✅ ChromeDriver encontrado: {driver_path}")
            return driver_path
            
        # If path doesn't end with .exe, search for the actual executable
        print("⚠️ Procurando executável do ChromeDriver...")
        driver_dir = os.path.dirname(driver_path)
        for file in os.listdir(driver_dir):
            if file.endswith('.exe') and 'chromedriver' in file.lower():
                exe_path = os.path.join(driver_dir, file)
                if os.path.exists(exe_path):
                    print(f"✅ ChromeDriver executável encontrado: {exe_path}")
                    return exe_path
        
        # If still no valid path, clear cache and try again
        print("🔄 ChromeDriver inválido, limpando cache...")
        cache_dir = os.path.expanduser('~/.wdm')
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
            print("✅ Cache limpo")
            
        # Retry after cache clear
        print("🔄 Reinstalando ChromeDriver...")
        driver_path = ChromeDriverManager().install()
        
        if driver_path.endswith('.exe'):
            print(f"✅ ChromeDriver reinstalado: {driver_path}")
            return driver_path
            
        # Last attempt: find any chromedriver.exe in the directory
        driver_dir = os.path.dirname(driver_path)
        for file in os.listdir(driver_dir):
            if file == 'chromedriver.exe':
                exe_path = os.path.join(driver_dir, file)
                print(f"✅ ChromeDriver encontrado: {exe_path}")
                return exe_path
                
        raise Exception("ChromeDriver executável não encontrado")
        
    except Exception as e:
        raise Exception(f"Falha ao configurar ChromeDriver: {e}. Verifique se o Chrome está instalado.")

def create_driver(website=None):
    """Create optimized Chrome driver with robust error handling"""
    try:
        # Get ChromeDriver path
        driver_path = get_chromedriver_path()
        service = Service(driver_path)
        
        options = ChromeOptions()
        
        # Common Chrome options for performance and stealth
        options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--disable-extensions")
        options.add_argument("--disable-plugins")
        options.add_argument("--disable-images")
        options.add_argument("--disable-web-security")
        options.add_argument("--allow-running-insecure-content")
        options.add_argument("--ignore-certificate-errors")
        options.add_argument("--disable-background-timer-throttling")
        options.add_argument("--disable-backgrounding-occluded-windows")
        options.add_argument("--disable-renderer-backgrounding")
        options.add_argument("--disable-features=TranslateUI")
        options.add_argument("--disable-ipc-flooding-protection")
        
        # Memory optimization
        options.add_argument("--memory-pressure-off")
        options.add_argument("--max_old_space_size=2048")
        options.add_argument("--aggressive-cache-discard")
        
        # User agent rotation
        user_agents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        ]
        options.add_argument(f"--user-agent={random.choice(user_agents)}")
        
        # Anti-detection
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option('useAutomationExtension', False)
        options.add_argument("--disable-blink-features=AutomationControlled")
        
        driver = webdriver.Chrome(service=service, options=options)
        
        # Optimized timeouts
        driver.set_page_load_timeout(30)
        driver.implicitly_wait(10)
        
        # Hide webdriver property
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        
        return driver
        
    except Exception as e:
        print(f"❌ Erro ao criar driver Chrome: {e}")
        return None

def process_search(website, search_config):
    """Process a single search with proper error handling"""
    if stop_event.is_set():
        return 0, 0
    
    try:
        with managed_driver(website) as driver:
            wait = WebDriverWait(driver, TIMEOUT)
            
            if website == "kabum":
                found, saved = scrape_kabum(driver, wait, search_config["search_text"], 
                                          search_config["keywords"], search_config["category"])
            elif website == "pichau":
                found, saved = scrape_pichau(driver, wait, search_config["search_text"], 
                                           search_config["keywords"], search_config["category"])
            elif website == "terabyte":
                found, saved = scrape_terabyte(driver, wait, search_config["search_text"], 
                                             search_config["keywords"], search_config["category"])
            else:
                return 0, 0
            
            return found, saved
            
    except Exception as e:
        print(f"❌ Erro na busca '{search_config['search_text']}' em {website}: {e}")
        return 0, 0

def start_search():
    """Main search loop with optimized error handling"""
    def search_task():
        scan_count = 0
        
        try:
            while not stop_event.is_set():
                scan_count += 1
                print(f"\n{'='*50}")
                print(f"   INICIANDO SCAN #{scan_count}")
                print(f"{'='*50}")
                
                start_time = time.time()
                total_found = 0
                total_saved = 0
                total_searches = 0
                
                try:
                    all_searches = get_search_configs_with_keywords()
                    
                    if not all_searches:
                        print("❌ Nenhuma configuração de busca ativa")
                        if stop_event.wait(300):  # 5 minutes
                            break
                        continue
                    
                    # Organize by website (kabum, terabyte e pichau)
                    searches_by_website = {"kabum": [], "terabyte": [], "pichau": []}
                    
                    for search in all_searches:
                        website = search['website']
                        if website in searches_by_website:
                            searches_by_website[website].append(search)
                    
                    # Process each website sequentially for stability
                    for website, searches in searches_by_website.items():
                        if not searches or stop_event.is_set():
                            continue
                        
                        print(f"\n🔍 {website.upper()}: {len(searches)} buscas")
                        website_found = 0
                        website_saved = 0
                        
                        for search in searches:
                            if stop_event.is_set():
                                break
                            
                            found, saved = process_search(website, search)
                            website_found += found
                            website_saved += saved
                            total_searches += 1
                            
                            # Small delay between searches
                            if random_delay():
                                break
                        
                        total_found += website_found
                        total_saved += website_saved
                        
                        print(f"✅ {website.upper()}: {website_found} encontrados, {website_saved} salvos")
                        
                        # Delay between websites
                        if stop_event.wait(random.uniform(2, 4)):
                            break
                    
                except Exception as e:
                    print(f"❌ Erro no ciclo de busca: {e}")
                
                # Final summary
                elapsed = time.time() - start_time
                print(f"\n📊 RESUMO SCAN #{scan_count}:")
                print(f"   Tempo: {elapsed:.1f}s")
                print(f"   Buscas: {total_searches}")
                print(f"   Produtos encontrados: {total_found}")
                print(f"   Produtos salvos: {total_saved}")
                
                if total_found > 0:
                    success_rate = (total_saved / total_found) * 100
                    print(f"   Taxa de sucesso: {success_rate:.1f}%")
                
                if stop_event.is_set():
                    break
                
                # Wait for next scan
                delay = max(360 - elapsed, 60)
                print(f"\n⏳ Próximo scan em {delay//60} minutos...")
                
                if stop_event.wait(delay):
                    break
                    
        except Exception as e:
            print(f"❌ Erro crítico: {e}")
        finally:
            print("🛑 Search task finalizada")

    search_thread = threading.Thread(target=search_task, daemon=True)
    search_thread.start()
    return search_thread

def signal_handler(sig, frame):
    """Handle shutdown signals gracefully"""
    print("\n🛑 Parando graciosamente...")
    stop_event.set()
    cleanup_browser_processes()

if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("🚀 Iniciando PC Scraper v3.0 - Full Chrome Edition")
    print(f"Sistema: {'Windows' if is_windows else 'Linux'} | Driver: Chrome")
    print("Pressione Ctrl+C para parar")
    
    # Initial cleanup
    cleanup_browser_processes()
    
    search_thread = start_search()
    
    try:
        while not stop_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n⌨️ Interrupção do teclado")
        stop_event.set()
    finally:
        print("🔄 Finalizando threads...")
        
        cleanup_browser_processes()
        
        if search_thread.is_alive():
            search_thread.join(timeout=10)
        
        cleanup_browser_processes()
        print("✅ Finalização completa")
        sys.exit(0)
