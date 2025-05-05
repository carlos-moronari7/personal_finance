# database.py
import sqlite3
import sys
from pathlib import Path
import logging
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import List, Optional, Tuple, Dict, Any
from contextlib import contextmanager

# --- Setup Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - DB - %(message)s')

# --- Decimal Adapters for SQLite ---
def adapt_decimal(d: Decimal) -> str:
    return str(d)

def convert_decimal(s: bytes) -> Decimal:
    try:
        decoded = s.decode('utf-8')
        if not decoded:
            # logging.warning("Empty string encountered converting DECIMAL. Returning 0.00") # Less noisy
            return Decimal('0.00')
        return Decimal(decoded)
    except InvalidOperation:
        logging.warning(f"Could not convert '{s.decode('utf-8')}' to Decimal. Returning 0.00")
        return Decimal('0.00')
    except UnicodeDecodeError:
        logging.error(f"Could not decode bytes '{s}' as utf-8. Returning 0.00")
        return Decimal('0.00')

sqlite3.register_adapter(Decimal, adapt_decimal)
sqlite3.register_converter("DECIMAL", convert_decimal)

# Database file path
if getattr(sys, 'frozen', False):
    base_path = Path(sys.executable).parent
else:
    # Assumes this file is in 'data' subdirectory, db is one level up
    base_path = Path(__file__).resolve().parent.parent

DB_FILE = base_path / "personal_finance.db"
logging.info(f"Database file path determined as: {DB_FILE}")

@contextmanager
def get_db_connection():
    """Yields a database connection configured for Decimal."""
    conn = None
    try:
        # Ensure directory exists (useful if running from different locations)
        DB_FILE.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_FILE, detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
        conn.commit()
    except sqlite3.Error as e:
        logging.error(f"Database error: {e}")
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()

def initialize_db():
    """Creates/updates database tables using TEXT for monetary values."""
    logging.info("Initializing database schema...")
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()

            # Accounts Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    initial_balance TEXT NOT NULL DEFAULT '0.00', /* Store as TEXT */
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Categories Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    type TEXT NOT NULL CHECK(type IN ('expense', 'income')) DEFAULT 'expense',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("INSERT OR IGNORE INTO categories (name, type) VALUES (?, ?)", ('Uncategorized', 'expense'))

            # Transactions Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    date TEXT NOT NULL, -- Store dates as ISO8601 strings (YYYY-MM-DD)
                    description TEXT NOT NULL COLLATE NOCASE,
                    amount TEXT NOT NULL, /* Store as TEXT */
                    category_id INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
                    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions (account_id, date)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions (category_id, date)")

            # Budgets Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS budgets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category_id INTEGER NOT NULL,
                    month TEXT NOT NULL, -- Store month as YYYY-MM string
                    amount TEXT NOT NULL DEFAULT '0.00', /* Store as TEXT */
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (category_id, month),
                    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_budgets_month_category ON budgets (month, category_id)")

            # --- NEW: Settings Table ---
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT
                )
            """)
            # Set default theme if not present
            cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ('theme', 'light'))
            # --- END NEW ---

            # Migration logic (can be run safely multiple times)
            _migrate_real_to_text(cursor)

        logging.info("Database schema initialization/check complete.")
    except sqlite3.Error as e:
        logging.error(f"Error initializing/migrating database schema: {e}", exc_info=True)
        raise

# --- Migration Functions (Keep if needed) ---
def _has_column_type(cursor: sqlite3.Cursor, table_name: str, column_name: str, expected_type: str) -> bool:
    try:
        # Use parameterized query for table name if possible, though PRAGMA often doesn't support it directly.
        # Using f-string here is common but be aware of potential (though low for table_info) injection risks if table_name came from user input.
        cursor.execute(f"PRAGMA table_info(\"{table_name}\")")
        columns = cursor.fetchall()
        return any(col['name'].lower() == column_name.lower() and col['type'].upper() == expected_type.upper() for col in columns)
    except sqlite3.Error as e:
        logging.error(f"Error checking column type for {table_name}.{column_name}: {e}")
        return False

def _migrate_real_to_text(cursor: sqlite3.Cursor):
    logging.info("Checking for necessary data type migrations (REAL -> TEXT)...")
    migrated_any = False
    tables_to_check = {'accounts': ['initial_balance'],'transactions': ['amount'],'budgets': ['amount']}
    for table, columns in tables_to_check.items():
        try:
            # Check if table exists first
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
            if not cursor.fetchone():
                logging.debug(f"Table '{table}' not found, skipping migration check.")
                continue

            for column in columns:
                cursor.execute(f"PRAGMA table_info(\"{table}\")") # Use quotes for safety
                col_info = next((c for c in cursor.fetchall() if c['name'].lower() == column.lower()), None)

                if col_info and col_info['type'].upper() == 'REAL':
                    logging.warning(f"Found REAL column: {table}.{column}. Attempting migration to TEXT...")
                    new_table_name = f"{table}_migrate_temp" # Use different temp name convention
                    try:
                        # Get column definitions
                        cursor.execute(f"PRAGMA table_info(\"{table}\")")
                        cols_defs = []
                        col_names = []
                        for col in cursor.fetchall():
                            col_name = col['name']
                            col_type = col['type']
                            col_notnull = 'NOT NULL' if col['notnull'] else ''
                            col_default = f"DEFAULT {col['dflt_value']}" if col['dflt_value'] is not None else ''
                            col_pk = 'PRIMARY KEY' if col['pk'] else ''
                            col_names.append(col_name)
                            if col_name.lower() == column.lower():
                                col_type = 'TEXT' # Change type
                            # Quote column names to handle potential keywords/spaces
                            cols_defs.append(f"\"{col_name}\" {col_type} {col_pk} {col_notnull} {col_default}")

                        # Create new table
                        create_sql = f"CREATE TABLE \"{new_table_name}\" ({', '.join(cols_defs)})"
                        cursor.execute(f"DROP TABLE IF EXISTS \"{new_table_name}\"")
                        cursor.execute(create_sql)

                        # Copy data, casting the target column
                        target_cols_str = ', '.join(f"\"{c}\"" for c in col_names)
                        select_cols_str = ', '.join([f"CAST(\"{c}\" AS TEXT)" if c.lower() == column.lower() else f"\"{c}\"" for c in col_names])
                        copy_sql = f"INSERT INTO \"{new_table_name}\" ({target_cols_str}) SELECT {select_cols_str} FROM \"{table}\""
                        cursor.execute(copy_sql)

                        # Drop old table, rename new table
                        cursor.execute(f"DROP TABLE \"{table}\"")
                        cursor.execute(f"ALTER TABLE \"{new_table_name}\" RENAME TO \"{table}\"")

                        # Recreate indexes (assuming standard naming conventions)
                        if table == 'transactions':
                            cursor.execute("CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions (account_id, date)")
                            cursor.execute("CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions (category_id, date)")
                        if table == 'budgets':
                            cursor.execute("CREATE INDEX IF NOT EXISTS idx_budgets_month_category ON budgets (month, category_id)")

                        logging.info(f"Migration successful for {table}.{column}")
                        migrated_any = True
                    except sqlite3.Error as migrate_err:
                        logging.error(f"Migration FAILED for {table}.{column}: {migrate_err}. Rolling back.")
                        raise migrate_err # Propagate error to ensure transaction rollback

        except sqlite3.Error as table_err:
             logging.error(f"Error processing migrations for table {table}: {table_err}")
             # Decide if you want to raise here or continue with other tables

    if not migrated_any:
        logging.info("No REAL columns found needing migration.")


# === Category Functions ===
def add_category(name: str, type: str = 'expense') -> Optional[int]:
    sql = "INSERT INTO categories (name, type) VALUES (?, ?)"; cleaned_name = name.strip()
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, (cleaned_name, type)); return cursor.lastrowid
    except sqlite3.IntegrityError: logging.warning(f"Category name '{cleaned_name}' likely exists."); return None
    except sqlite3.Error as e: logging.error(f"Error adding category '{cleaned_name}': {e}"); return None

def get_categories(category_type: Optional[str] = None) -> List[sqlite3.Row]:
    sql = "SELECT id, name, type FROM categories"; params: List[Any] = []
    if category_type in ['expense', 'income']: sql += " WHERE type = ?"; params.append(category_type)
    sql += " ORDER BY name COLLATE NOCASE"
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, params); return cursor.fetchall()
    except sqlite3.Error as e: logging.error(f"Error fetching categories (type: {category_type}): {e}"); return []

def update_category(category_id: int, new_name: str, new_type: str) -> bool:
    cleaned_name = new_name.strip(); cleaned_type = new_type.strip().lower()
    if not cleaned_name: logging.error("Update category failed: New name empty."); return False
    if cleaned_name.lower() == 'uncategorized': logging.error("Update category failed: Cannot rename to 'Uncategorized'."); return False
    if cleaned_type not in ['expense', 'income']: logging.error(f"Update category failed: Invalid type '{new_type}'."); return False

    sql = "UPDATE categories SET name = ?, type = ? WHERE id = ?"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            # Check if the category being updated is the original 'Uncategorized' one first
            cursor.execute("SELECT name FROM categories WHERE id = ?", (category_id,))
            original_cat = cursor.fetchone()
            if not original_cat: logging.warning(f"Update category {category_id}: ID not found."); return False # Not found
            if original_cat['name'].lower() == 'uncategorized': logging.error("Cannot modify 'Uncategorized'."); return False # Is default

            cursor.execute(sql, (cleaned_name, cleaned_type, category_id))
            updated = cursor.rowcount > 0
            if updated: logging.info(f"Updated category {category_id}");
            # else: logging.warning(f"Update category {category_id}: No rows affected (data may be unchanged)."); # Optional noise
            return updated
    except sqlite3.IntegrityError: logging.warning(f"Integrity error updating category {category_id}: Name '{cleaned_name}' likely exists."); return False
    except sqlite3.Error as e: logging.error(f"Error updating category {category_id}: {e}"); return False

def delete_category(category_id: int) -> bool:
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM categories WHERE id = ?", (category_id,))
            cat = cursor.fetchone()
            if not cat: logging.warning(f"Delete category {category_id}: ID not found."); return False # Not found
            if cat['name'].lower() == 'uncategorized': logging.error("Cannot delete 'Uncategorized'."); return False # Is default

            cursor.execute("PRAGMA foreign_keys = ON");
            sql = "DELETE FROM categories WHERE id = ?"
            cursor.execute(sql, (category_id,))
            deleted = cursor.rowcount > 0
            # Logging done within the block based on 'deleted'
            return deleted
    except sqlite3.Error as e: logging.error(f"Error deleting category {category_id}: {e}"); return False


# === Budget Functions ===
def set_budget(category_id: int, month_str: str, amount: Decimal) -> bool:
    budget_amount = max(Decimal('0.00'), amount).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    sql = "INSERT INTO budgets (category_id, month, amount) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET amount = excluded.amount"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor();
            cursor.execute("SELECT type, name FROM categories WHERE id = ?", (category_id,))
            cat_result = cursor.fetchone()
            if not cat_result: logging.error(f"Set budget failed: CatID {category_id} not found."); return False
            if cat_result['type'] != 'expense': logging.error(f"Set budget failed: Cat '{cat_result['name']}' not expense type."); return False
            if not (len(month_str) == 7 and month_str[4] == '-'): logging.error(f"Invalid month format: '{month_str}'."); return False
            cursor.execute(sql, (category_id, month_str, budget_amount))
            # logging.info(f"Set budget Cat {category_id}, Month {month_str} to {budget_amount}") # Less verbose?
            return True
    except sqlite3.Error as e: logging.error(f"Error setting budget C:{category_id} M:{month_str}: {e}"); return False

def get_budgets_for_month(month_str: str) -> List[sqlite3.Row]:
    sql = "SELECT b.id, b.category_id, c.name as category_name, c.type as category_type, b.month, b.amount as \"amount [DECIMAL]\" FROM budgets b JOIN categories c ON b.category_id = c.id WHERE b.month = ? AND c.type = 'expense' ORDER BY c.name COLLATE NOCASE"
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, (month_str,)); return cursor.fetchall()
    except sqlite3.Error as e: logging.error(f"Error getting budgets for {month_str}: {e}"); return []

def get_spending_for_category_month(category_id: int, month_str: str) -> Decimal:
    date_pattern = f"{month_str}-%"; sql = "SELECT SUM(amount) as \"total [DECIMAL]\" FROM transactions WHERE category_id = ? AND date LIKE ? AND CAST(amount AS REAL) < 0"; total_spending = Decimal('0.00')
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, (category_id, date_pattern)); result = cursor.fetchone();
        if result and result['total'] is not None: total_spending = abs(result['total'])
    except sqlite3.Error as e: logging.error(f"Error getting spending C:{category_id} M:{month_str}: {e}")
    return total_spending.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

# === Transaction Functions ===
def add_transaction(account_id: int, date_str: str, description: str, amount: Decimal, category_id: Optional[int] = None) -> Optional[int]:
    sql = "INSERT INTO transactions (account_id, date, description, amount, category_id) VALUES (?, ?, ?, ?, ?)"; cleaned_desc = description.strip()
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor(); amount_quantized = amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            if category_id is not None:
                cursor.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,))
                if not cursor.fetchone(): logging.warning(f"Add Tx: CatID {category_id} not found, setting NULL."); category_id = None
            cursor.execute(sql, (account_id, date_str, cleaned_desc, amount_quantized, category_id)); return cursor.lastrowid
    except sqlite3.IntegrityError as e: logging.error(f"Integrity error adding tx (AccID:{account_id}?): {e}"); return None
    except sqlite3.Error as e: logging.error(f"Error adding transaction: {e}"); return None

def get_transactions(account_id: Optional[int] = None, limit: Optional[int] = None) -> List[sqlite3.Row]:
    sql = "SELECT t.id, t.account_id, a.name as account_name, t.date, t.description, t.amount as \"amount [DECIMAL]\", t.category_id, IFNULL(c.name, 'Uncategorized') as category_name, IFNULL(c.type, 'expense') as category_type FROM transactions t JOIN accounts a ON t.account_id = a.id LEFT JOIN categories c ON t.category_id = c.id"; params: List[Any] = []
    if account_id is not None: sql += " WHERE t.account_id = ?"; params.append(account_id)
    sql += " ORDER BY t.date DESC, t.id DESC"
    if limit is not None and limit > 0: sql += " LIMIT ?"; params.append(limit)
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, params); return cursor.fetchall()
    except sqlite3.Error as e: logging.error(f"Error fetching transactions (Acc:{account_id}, Lim:{limit}): {e}"); return []

def get_transaction_by_id(transaction_id: int) -> Optional[sqlite3.Row]:
    sql = "SELECT t.id, t.account_id, t.date, t.description, t.amount as \"amount [DECIMAL]\", t.category_id, IFNULL(c.name, 'Uncategorized') as category_name FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.id = ?"
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql, (transaction_id,)); return cursor.fetchone()
    except sqlite3.Error as e: logging.error(f"Error fetching transaction {transaction_id}: {e}"); return None

def update_transaction(transaction_id: int, account_id: int, date_str: str, description: str, amount: Decimal, category_id: Optional[int] = None) -> bool:
    sql = "UPDATE transactions SET account_id = ?, date = ?, description = ?, amount = ?, category_id = ? WHERE id = ?"; cleaned_desc = description.strip()
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor(); amount_quantized = amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            if category_id is not None:
                cursor.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,))
                if not cursor.fetchone(): logging.warning(f"Update Tx {transaction_id}: CatID {category_id} not found, setting NULL."); category_id = None
            cursor.execute(sql, (account_id, date_str, cleaned_desc, amount_quantized, category_id, transaction_id)); updated = cursor.rowcount > 0;
            # Optional logging can go here based on 'updated'
            return updated
    except sqlite3.IntegrityError as e: logging.error(f"Integrity error updating tx {transaction_id} (AccID:{account_id}?): {e}"); return False
    except sqlite3.Error as e: logging.error(f"Error updating transaction {transaction_id}: {e}"); return False

def delete_transaction(transaction_id: int) -> bool:
    sql = "DELETE FROM transactions WHERE id = ?"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor(); cursor.execute("PRAGMA foreign_keys = ON"); cursor.execute(sql, (transaction_id,)); deleted = cursor.rowcount > 0;
            if not deleted: logging.warning(f"Tx ID {transaction_id} not found for deletion.");
            return deleted
    except sqlite3.Error as e: logging.error(f"Error deleting transaction {transaction_id}: {e}"); return False

# === Account Functions ===
def add_account(name: str, initial_balance: Decimal = Decimal('0.00')) -> Optional[int]:
    sql = "INSERT INTO accounts (name, initial_balance) VALUES (?, ?)"; cleaned_name = name.strip()
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); balance_quantized = initial_balance.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP); cursor.execute(sql, (cleaned_name, balance_quantized)); return cursor.lastrowid
    except sqlite3.IntegrityError: logging.warning(f"Account name '{cleaned_name}' likely exists."); return None
    except sqlite3.Error as e: logging.error(f"Error adding account '{cleaned_name}': {e}"); return None

def get_accounts() -> List[sqlite3.Row]:
    sql = "SELECT id, name, initial_balance as \"initial_balance [DECIMAL]\" FROM accounts ORDER BY name COLLATE NOCASE"
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute(sql); return cursor.fetchall()
    except sqlite3.Error as e: logging.error(f"Error fetching accounts: {e}"); return []

def delete_account(account_id: int) -> bool:
    sql = "DELETE FROM accounts WHERE id = ?"
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); cursor.execute("PRAGMA foreign_keys = ON"); cursor.execute(sql, (account_id,)); deleted = cursor.rowcount > 0;
        if not deleted: logging.warning(f"Account ID {account_id} not found for deletion.");
        # else: logging.info(f"Deleted account {account_id} and transactions."); # Optional log
        return deleted
    except sqlite3.Error as e: logging.error(f"Error deleting account {account_id}: {e}"); return False

def update_account(account_id: int, new_name: str, new_initial_balance: Decimal) -> bool:
    sql = "UPDATE accounts SET name = ?, initial_balance = ? WHERE id = ?"; cleaned_name = new_name.strip()
    try:
        with get_db_connection() as conn: cursor = conn.cursor(); balance_quantized = new_initial_balance.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP); cursor.execute(sql, (cleaned_name, balance_quantized, account_id)); updated = cursor.rowcount > 0;
        # if not updated: logging.warning(f"Update account {account_id}: No rows affected."); # Optional log
        return updated
    except sqlite3.IntegrityError: logging.warning(f"Integrity error updating account {account_id}: Name '{cleaned_name}' likely exists."); return False
    except sqlite3.Error as e: logging.error(f"Error updating account {account_id}: {e}"); return False

# === Balance Calculation Functions ===
def get_account_current_balance(account_id: int) -> Decimal:
    """Calculates the current balance for a single account."""
    current_balance = Decimal('0.00')
    try:
        with get_db_connection() as conn:
             cursor = conn.cursor(); cursor.execute("SELECT initial_balance as \"initial_balance [DECIMAL]\" FROM accounts WHERE id = ?", (account_id,)); result_initial = cursor.fetchone();
             if not result_initial: logging.warning(f"AccID {account_id} not found for balance calc."); return Decimal('0.00')
             initial_balance = result_initial['initial_balance']; current_balance = initial_balance if isinstance(initial_balance, Decimal) else Decimal('0.00')
             cursor.execute("SELECT SUM(amount) as \"total_transactions [DECIMAL]\" FROM transactions WHERE account_id = ?", (account_id,)); result_sum = cursor.fetchone(); transaction_sum = result_sum['total_transactions']
             if isinstance(transaction_sum, Decimal): current_balance += transaction_sum
             return current_balance.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    except sqlite3.Error as e: logging.error(f"Error calculating balance AccID {account_id}: {e}"); return Decimal('0.00')

def get_all_accounts_with_balances() -> List[Dict[str, Any]]:
    """Fetches all accounts and calculates their current balances."""
    accounts = []
    try:
        base_accounts = get_accounts();
        for acc_row in base_accounts: acc_dict = dict(acc_row); acc_dict['current_balance'] = get_account_current_balance(acc_dict['id']); accounts.append(acc_dict)
        return accounts
    except Exception as e: logging.error(f"Error getting all accounts with balances: {e}"); return []

def get_total_net_balance() -> Decimal:
    """Calculates the sum of current balances across all accounts."""
    total_balance = sum(acc.get('current_balance', Decimal('0.00')) for acc in get_all_accounts_with_balances())
    return total_balance.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

# === Reporting Functions ===
def get_spending_by_category(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    sql = "SELECT IFNULL(c.name, 'Uncategorized') as category_name, SUM(t.amount) as \"total_amount [DECIMAL]\" FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE CAST(t.amount AS REAL) < 0 AND t.date BETWEEN ? AND ? GROUP BY category_name HAVING SUM(t.amount) < '0' ORDER BY ABS(SUM(t.amount)) DESC"
    spending_data = []
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor(); cursor.execute(sql, (start_date, end_date)); results = cursor.fetchall();
            for row in results:
                spending_amount = abs(row['total_amount'] or Decimal('0.00')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                if spending_amount > 0: spending_data.append({"category_name": row['category_name'],"spent_amount": spending_amount})
    except Exception as e: logging.error(f"Error getting spending by category ({start_date} to {end_date}): {e}"); return []
    return spending_data

def get_income_expense_summary_for_month(month_str: str) -> Dict[str, Decimal]:
    """Calculates total income and total expenses for a given month (YYYY-MM)."""
    income = Decimal('0.00'); expense = Decimal('0.00'); date_pattern = f"{month_str}-%"
    sql_income = "SELECT SUM(amount) as \"total [DECIMAL]\" FROM transactions WHERE date LIKE ? AND CAST(amount AS REAL) > 0"
    sql_expense = "SELECT SUM(amount) as \"total [DECIMAL]\" FROM transactions WHERE date LIKE ? AND CAST(amount AS REAL) < 0"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor(); cursor.execute(sql_income, (date_pattern,)); result_income = cursor.fetchone();
            if result_income and result_income['total'] is not None: income = result_income['total']
            cursor.execute(sql_expense, (date_pattern,)); result_expense = cursor.fetchone();
            if result_expense and result_expense['total'] is not None: expense = abs(result_expense['total'])
    except sqlite3.Error as e: logging.error(f"Error getting income/expense summary M:{month_str}: {e}"); return {'total_income': Decimal('0.00'), 'total_expense': Decimal('0.00')}
    return {'total_income': income.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), 'total_expense': expense.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)}

# === Settings Functions ===
def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    """Retrieves a setting value from the database."""
    sql = "SELECT value FROM settings WHERE key = ?"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql, (key,))
            result = cursor.fetchone()
            # Return the value if found, otherwise the provided default
            value = result['value'] if result else default
            logging.debug(f"Retrieved setting '{key}': '{value}' (Default: '{default}')")
            return value
    except sqlite3.Error as e:
        logging.error(f"Error getting setting '{key}': {e}")
        return default # Return default on error

def set_setting(key: str, value: str) -> bool:
    """Saves or updates a setting value in the database."""
    sql = "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql, (key, value))
            logging.info(f"Set setting '{key}' to '{value}'")
            return True
    except sqlite3.Error as e:
        logging.error(f"Error setting setting '{key}' to '{value}': {e}")
        return False