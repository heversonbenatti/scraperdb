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
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.firefox import GeckoDriverManager

from sqlalchemy import create_engine, Table, Column, Integer, String, Numeric, ForeignKey, MetaData, select, Boolean, DateTime
from datetime import datetime, timedelta

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
    Column("keywords", String, nullable=False),  # Comma-separated keywords within a group
    Column("created_at", DateTime, default=datetime.now),
)

gecko_path = GeckoDriverManager().install()

TIMEOUT = 25

# Global stop event
stop_event = threading.Event()

def random_delay():
    # Check for stop event during delays
    delay_time = random.uniform(1, 3)
    if stop_event.wait(delay_time):
        return True  # Stop requested
    return False

def normalize_price_pichau(price_text):
    """
    Função para normalizar preços da Pichau e evitar problemas de formatação
    """
    try:
        # Remove espaços e caracteres especiais
        clean_text = price_text.replace("\xa0", " ").replace("R$", "").replace(" ", "").strip()
        
        # Se tem ponto E vírgula, assume formato brasileiro correto (ex: 1.499,99)
        if "." in clean_text and "," in clean_text:
            # Remove pontos (separadores de milhares) e troca vírgula por ponto
            clean_text = clean_text.replace(".", "").replace(",", ".")
            price = float(clean_text)
        # Se tem apenas vírgula, assume formato brasileiro (ex: 499,99)
        elif "," in clean_text and "." not in clean_text:
            clean_text = clean_text.replace(",", ".")
            price = float(clean_text)
        # Se tem apenas ponto, verifica se é separador decimal ou milhares
        elif "." in clean_text and "," not in clean_text:
            # Se tem mais de 3 dígitos após o ponto, provavelmente é erro de formatação
            parts = clean_text.split(".")
            if len(parts) == 2 and len(parts[1]) > 2:
                # Exemplo: 49999.00 deve ser 499.99
                # Reconstrói o preço dividindo por 100
                price = float(clean_text) / 100
            else:
                # Formato normal com ponto como decimal
                price = float(clean_text)
        else:
            # Apenas números
            price = float(clean_text)
        
        # Validação adicional: se o preço é muito alto (>10000), pode ser erro
        if price > 10000:
            # Tenta dividir por 100 para corrigir
            corrected_price = price / 100
            # Se o preço corrigido fica entre 10 e 10000, provavelmente estava errado
            if 10 <= corrected_price <= 10000:
                print(f"⚠️ Preço suspeito corrigido: {price} -> {corrected_price}")
                price = corrected_price
        
        return price
        
    except Exception as e:
        print(f"❌ Erro ao normalizar preço '{price_text}': {e}")
        return 0.0
    
def notify_price_drop_if_needed(product_name, old_price, new_price, website):
    if new_price < old_price:  # Só notifica quedas
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
                # 1. Verificar se produto existe, se não, criar
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
                
                # 2. Buscar último preço registrado para este produto
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
                
                # 3. Decidir se inserir novo registro ou atualizar existente
                if last_price_result is None:
                    # Primeiro preço para este produto
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
                    # Converter preços para float para comparação segura
                    last_price = float(last_price_result.price)
                    current_price = float(price)
                    
                    if abs(last_price - current_price) > 0.01:  # Mudança significativa (> R$ 0,01)
                        # Preço mudou - inserir novo registro
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
                        
                        # 🚨 TELEGRAM: Notificar mudança de preço (SÓ QUEDAS!)
                        notify_price_drop_if_needed(
                            product_name=name,
                            old_price=last_price,
                            new_price=current_price,
                            website=website
                        )
                        
                    else:
                        # Preço igual - apenas atualizar last_checked_at e incrementar contador
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
            # Get active search configs
            configs_query = select(
                search_configs.c.id,
                search_configs.c.search_text,
                search_configs.c.category,
                search_configs.c.website
            ).where(search_configs.c.is_active == True)
            
            configs = conn.execute(configs_query).fetchall()
            
            # For each config, get its keyword groups
            configs_with_keywords = []
            for config in configs:
                keywords_query = select(keyword_groups.c.keywords).where(
                    keyword_groups.c.search_config_id == config.id
                )
                keyword_rows = conn.execute(keywords_query).fetchall()
                
                # Convert keyword groups to the expected format
                keyword_groups_list = []
                for row in keyword_rows:
                    # Split comma-separated keywords and clean them
                    keywords_in_group = [k.strip() for k in row.keywords.split(',') if k.strip()]
                    if keywords_in_group:
                        keyword_groups_list.append(keywords_in_group)
                
                if keyword_groups_list:  # Only include configs that have keywords
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

def scrape_kabum(driver, wait, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Kabum: {query}")
    base_url = "https://www.kabum.com.br"
    url = f"{base_url}/busca/{quote_plus(query.replace(' ', '-'))}?page_number=1&page_size=100&facet_filters=&sort=most_searched&variant=null&redirect_terms=true"
    
    try:
        driver.get(url)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "article.productCard")))
    except:
        print(f"⚠️ Page didn't load or doesn't exist")
        return
        
    if stop_event.is_set():
        return
        
    soup = BeautifulSoup(driver.page_source, "html.parser")
    cards = soup.select("article.productCard")
    
    for card in cards:
        if stop_event.is_set():
            return
            
        try:
            name = card.select_one(".nameCard").get_text(strip=True).lower()
            matched_keywords = []
            for words in wordlist:
                if all(p.lower() in name for p in words):
                    matched_keywords.append(words)
            
            if matched_keywords:
                product_link = base_url+card.select_one("a.productLink").get("href")
                price_elem = card.select_one('[data-testid="price-value"], .priceCard')
                price_text = price_elem.get_text(strip=True)
                price = float(price_text.split("R$")[1].replace(".", "").replace(",", "."))
                save_product(name, price, "kabum", category, product_link, matched_keywords)
                
        except Exception as e:
            print(f"❌ Erro no parsing Kabum: {e}")

def scrape_pichau(driver, wait, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Pichau: {query}")
    base_url = "https://www.pichau.com.br"
    url = f"{base_url}{query}"
    
    try:
        driver.get(url)
        # Aguarda um pouco mais para garantir que os preços carregem completamente
        time.sleep(3)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-cy='list-product']")))
        # Aguarda adicional para garantir que os preços estejam formatados corretamente
        time.sleep(2)
    except:
        print(f"⚠️ Page didn't load or doesn't exist")
        return
        
    if stop_event.is_set():
        return
        
    soup = BeautifulSoup(driver.page_source, "html.parser")
    cards = soup.select("[data-cy='list-product']")
    
    for card in cards:
        if stop_event.is_set():
            return
            
        try:
            name = card.select_one("h2").get_text(strip=True).lower()
            matched_keywords = []
            for words in wordlist:
                if all(p.lower() in name for p in words):
                    matched_keywords.append(words)
            
            if matched_keywords:
                product_link = base_url + card.get("href")
                
                # Tenta diferentes seletores para o preço
                price_elem = card.select_one("div.mui-12athy2-price_vista, .price, [data-testid='price']")
                if not price_elem:
                    print(f"⚠️ Preço não encontrado para: {name}")
                    continue
                    
                price_text = price_elem.get_text(strip=True).replace("\xa0", " ")
                
                # Usa a função de normalização específica para Pichau
                price = normalize_price_pichau(price_text)
                
                if price > 0:
                    save_product(name, price, "pichau", category, product_link, matched_keywords)
                else:
                    print(f"⚠️ Preço inválido para {name}: {price_text}")
                
        except Exception as e:
            print(f"❌ Erro no parsing Pichau: {e}")

def scrape_terabyte(driver, wait, query, wordlist, category):
    if stop_event.is_set():
        return
        
    print(f"\n🔍 Searching on Terabyte: {query}")
    base_url = "https://www.terabyteshop.com.br"
    url = f"{base_url}/busca?str={quote_plus(query)}"
    
    try:
        driver.get(url)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".product-item")))
    except:
        print(f"⚠️ Page didn't load or doesn't exist")
        return
        
    if stop_event.is_set():
        return
        
    soup = BeautifulSoup(driver.page_source, "html.parser")
    cards = soup.select(".product-item")
    
    for card in cards:
        if stop_event.is_set():
            return
            
        try:
            name = card.select_one("h2").get_text(strip=True).lower()
            matched_keywords = []
            for words in wordlist:
                if all(p.lower() in name for p in words):
                    matched_keywords.append(words)
            
            if matched_keywords:
                product_link = card.select_one("a.product-item__image").get("href")
                price_elem = card.select_one(".product-item__new-price span")
                price_text = price_elem.get_text(strip=True)
                price = float(price_text.replace("R$", "").replace(".", "").replace(",", ".").strip())
                save_product(name, price, "terabyteshop", category, product_link, matched_keywords)
                
        except Exception as e:
            print(f"❌ Erro no parsing Terabyte: {e}")

def create_driver():
    opts = Options()
    opts.set_preference("permissions.default.image", 2)
    opts.set_preference("dom.ipc.plugins.enabled.libflashplayer.so", "false")
    opts.set_preference("media.autoplay.default", 5)
    opts.add_argument("--headless")
    
    # Rotate user agents
    user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15"
    ]
    opts.set_preference("general.useragent.override", random.choice(user_agents))
    
    # Disable WebDriver flag
    opts.set_preference("dom.webdriver.enabled", False)
    opts.set_preference("useAutomationExtension", False)
    
    driver = webdriver.Firefox(service=Service(gecko_path), options=opts)
    
    # Execute CDP command to hide selenium detection
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    
    return driver

def start_search():
    def search_task():
        try:
            while not stop_event.is_set():
                print("\n=== Starting new scan ===")
                start_time = time.time()
                
                if stop_event.is_set():
                    break
                
                try:
                    # Get all search configurations with their keywords
                    all_searches = get_search_configs_with_keywords()
                    
                    if not all_searches:
                        print("⚠️ No active search configurations found")
                        elapsed = time.time() - start_time
                        delay = max(360 - elapsed, 60)
                        print(f"\n⏳ Next scan in {delay//60} minutes...")
                        
                        # Wait with stop event checking
                        if stop_event.wait(delay):
                            break
                        continue
                    
                    # Organize searches by website
                    searches_by_website = {
                        "kabum": [],
                        "pichau": [],
                        "terabyte": []
                    }
                    
                    for search in all_searches:
                        website = search['website']
                        if website in searches_by_website:
                            searches_by_website[website].append(search)
                    
                    # Function to process all searches for one website
                    def process_website(website_name, searches):
                        for search in searches:
                            if stop_event.is_set():
                                return
                                
                            driver = None
                            try:
                                driver = create_driver()
                                wait = WebDriverWait(driver, TIMEOUT)
                                
                                if website_name == "kabum":
                                    scrape_kabum(driver, wait, search["search_text"], 
                                                search["keywords"], search["category"])
                                elif website_name == "pichau":
                                    scrape_pichau(driver, wait, search["search_text"], 
                                                 search["keywords"], search["category"])
                                elif website_name == "terabyte":
                                    scrape_terabyte(driver, wait, search["search_text"], 
                                                   search["keywords"], search["category"])
                                
                                # Check for stop before delay
                                if stop_event.is_set():
                                    return
                                    
                                # Use interruptible delay
                                if random_delay():
                                    return
                                    
                            except Exception as e:
                                print(f"🔥 Error during {website_name} search: {e}")
                            finally:
                                if driver:
                                    try:
                                        driver.quit()
                                    except:
                                        pass
                    
                    # Create and start threads (max 3 - one per website)
                    threads = []
                    for website, searches in searches_by_website.items():
                        if searches and not stop_event.is_set():  # Only create thread if there are searches for this website
                            t = threading.Thread(
                                target=process_website,
                                args=(website, searches),
                                daemon=True  # Make threads daemon so they don't prevent shutdown
                            )
                            threads.append(t)
                            t.start()
                            
                            # Stagger thread starts with stop checking
                            if stop_event.wait(random.uniform(0.5, 1.5)):
                                break
                    
                    # Wait for all threads to complete or stop event
                    for t in threads:
                        while t.is_alive() and not stop_event.is_set():
                            t.join(timeout=1)  # Check every second
                        
                        if stop_event.is_set():
                            break
                
                except Exception as e:
                    print(f"🔥 Error in search cycle: {e}")
                
                if stop_event.is_set():
                    break
                    
                elapsed = time.time() - start_time
                delay = max(360 - elapsed, 60)
                print(f"\n⏳ Next scan in {delay//60} minutes...")
                
                # Wait with stop event checking
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
    # Set up signal handling
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("🚀 Starting PC Scraper...")
    print("Press Ctrl+C to stop gracefully")
    
    search_thread = start_search()
    
    try:
        # Keep main thread alive and check for stop event
        while not stop_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n🛑 Keyboard interrupt received")
        stop_event.set()
    finally:
        print("⏳ Waiting for threads to finish...")
        
        # Give threads time to cleanup
        if search_thread.is_alive():
            search_thread.join(timeout=10)  # Wait max 10 seconds
        
        print("✅ Clean shutdown complete.")
        sys.exit(0)