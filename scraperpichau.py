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
    """Calculate historical weighted average using the CORRECT logic with check_count weighting"""
    try:
        with engine.begin() as conn:
            # Buscar TODOS os registros históricos, ordenados por data (mais antigo primeiro)
            query = select(
                prices.c.price,
                prices.c.check_count,
                prices.c.price_changed_at
            ).where(
                prices.c.product_id == product_id
            ).order_by(prices.c.price_changed_at.asc())  # Mais antigo primeiro
            
            all_price_records = conn.execute(query).fetchall()
            
            if len(all_price_records) <= 1:
                return None
            
            # O último registro é o preço atual
            current_record = all_price_records[-1]
            current_price = float(current_record.price)
            current_check_count = current_record.check_count or 1
            
            # Calcular média histórica ponderada usando TODOS os registros
            total_weighted_sum = 0
            total_check_counts = 0
            
            # Para todos os registros ANTERIORES (exceto o atual)
            for record in all_price_records[:-1]:
                price = float(record.price)
                check_count = max(1, record.check_count or 1)
                
                weighted_value = price * check_count
                total_weighted_sum += weighted_value
                total_check_counts += check_count
            
            # Para o registro ATUAL, usar (check_count - 1) se > 1
            # Isso evita que o preço atual influencie sua própria média de referência
            if current_check_count > 1:
                current_contribution_count = current_check_count - 1
                current_weighted_value = current_price * current_contribution_count
                total_weighted_sum += current_weighted_value
                total_check_counts += current_contribution_count
            
            # Se não há histórico suficiente, retornar None
            if total_check_counts == 0:
                return None
            
            # Calcular média ponderada
            weighted_average = total_weighted_sum / total_check_counts
            
            return weighted_average
                
    except Exception as e:
        print(f"Erro ao calcular média histórica: {e}")
        return None

def check_promotion_and_notify(product_id, product_name, current_price, product_link):
    """Check for real promotions using CORRECT discount calculation and notify"""
    try:
        weighted_average = calculate_weighted_average(product_id)
        
        if not weighted_average or weighted_average == current_price:
            return False
        
        # 🧮 NOVA LÓGICA: Cálculo correto de desconto
        # discountPercent = ((preço_atual - média_histórica) / média_histórica) × 100
        discount_percent = ((current_price - weighted_average) / weighted_average) * 100
        
        # Verificar se é desconto real (valor negativo = preço atual menor que média)
        is_actual_discount = discount_percent < 0
        actual_discount_percent = abs(discount_percent) if is_actual_discount else 0
        
        is_significant_discount = actual_discount_percent >= 10  # Mínimo 5% de desconto
        has_minimum_price = current_price >= 20                  # Preço mínimo R$ 20
        discount_amount = weighted_average - current_price
        
        is_promotion = (is_actual_discount and 
                       is_significant_discount and
                       has_minimum_price and 
                       discount_amount > 0)
        
        if is_promotion:
            try:
                bot = TelegramPriceBot()
                message = f" -- DESCONTO ENCONTRADO -- \n\n"
                message += f"Produto: {product_name}\n\n"
                message += f"Preço atual: R$ {current_price:.2f}\n"
                message += f"Preço médio: R$ {weighted_average:.2f}\n"
                message += f"Desconto: {actual_discount_percent:.1f}%\n"
                message += f"{product_link}"
                
                asyncio.run(bot.send_message(message))
                print(f"✅ Notificação enviada: {product_name} - {actual_discount_percent:.1f}% OFF")
                return True
            except Exception as e:
                print(f"❌ Erro ao enviar notificação: {e}")
        else:
            # Debug: mostrar por que não é promoção
            if not is_actual_discount:
                print(f"🔴 {product_name}: Preço MAIOR que média (+{actual_discount_percent:.1f}%)")
            elif not is_significant_discount:
                print(f"🟡 {product_name}: Desconto insuficiente ({actual_discount_percent:.1f}%)")
        
        return False
        
    except Exception as e:
        print(f"❌ Erro ao verificar promoção: {e}")
        return False

def save_product(name, price, website, category, product_link, keywords_matched=None):
    """Save product with optimized duplicate checking"""
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
            
            # Get last price
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
            current_time = datetime.now(brasilia)
            
            if last_price_result is None:
                # First price for this product
                conn.execute(prices.insert().values(
                    product_id=product_id,
                    price=price,
                    collected_at=current_time,
                    last_checked_at=current_time,
                    price_changed_at=current_time,
                    check_count=1
                ))
            else:
                last_price = float(last_price_result.price)
                current_price = float(price)
                
                if abs(last_price - current_price) > 0.01:
                    # Price changed - insert new record
                    conn.execute(prices.insert().values(
                        product_id=product_id,
                        price=current_price,
                        collected_at=current_time,
                        last_checked_at=current_time,
                        price_changed_at=current_time,
                        check_count=1
                    ))
                    
                    check_promotion_and_notify(product_id, name, current_price, product_link)
                else:
                    # Same price - update counters
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

    except Exception as e:
        print(f"❌ Erro ao salvar produto: {e}")


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
            
            if website == "pichau":
                found, saved = scrape_pichau(driver, wait, search_config["search_text"], 
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
                    
                    searches_by_website = {"pichau": []}
                    
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
    
    system_name = f"{'Windows' if is_windows else 'Linux'}"
    print(f"🚀 Iniciando PC Scraper v3.0 - Pichau Edition")
    print(f"Sistema: {system_name} | Driver: Chrome")
    print("Pressione Ctrl+C para parar")
    
    # 📱 NOTIFICAÇÃO DE INICIALIZAÇÃO
    try:
        bot = TelegramPriceBot()
        startup_message = f"🚀 SCRAPER INICIADO\n\n"
        startup_message += f"📋 Scraper: PICHAU\n"
        startup_message += f"💻 Sistema: {system_name}\n"
        startup_message += f"🕐 Hora: {datetime.now(brasilia).strftime('%d/%m/%Y às %H:%M:%S')}\n"
        startup_message += f"🔧 Versão: 3.0 (Nova Lógica de Desconto)"
        
        asyncio.run(bot.send_message(startup_message))
        print("✅ Notificação de inicialização enviada para Telegram")
    except Exception as e:
        print(f"⚠️ Erro ao enviar notificação de inicialização: {e}")
    
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
