# main.py
import webview
import os
import sys
import json
import datetime
import logging
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional, Dict, Any, List
from pathlib import Path
import pandas as pd # Make sure pandas is imported

# Assuming database.py is in ./data/ relative to main.py or in root
try:
    # Try importing from 'data' first
    from data import database
except ImportError:
    # Fallback if not in 'data' subdirectory
    try:
        import database
    except ImportError:
        logging.error("Could not import database module. Ensure database.py exists (in project root or 'data' subdir).")
        sys.exit(1)


# --- Setup Logging ---
log_format = '%(asctime)s - %(levelname)s - API - %(message)s'
logging.basicConfig(level=logging.INFO, format=log_format)

# --- JSON Encoder for Decimal ---
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return str(obj.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        return json.JSONEncoder.default(self, obj)

def api_response(success: bool, data: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> str:
    response = {"success": success}
    if data is not None: response["data"] = data
    if error is not None: response["error"] = error
    try:
        return json.dumps(response, cls=DecimalEncoder, ensure_ascii=True)
    except TypeError as e:
        logging.error(f"JSON Serialize Error: {e}. Resp: {response}", exc_info=True)
        return json.dumps({"success": False, "error": "Server serialization error."})

# --- Safe String to Decimal Conversion ---
def _parse_decimal_from_str(value_str: Optional[str], default: Decimal = Decimal('0.00')) -> Decimal:
    if value_str is None: return default
    cleaned_str = str(value_str).strip()
    if not cleaned_str: return default
    try: return Decimal(cleaned_str.replace(',', '.'))
    except InvalidOperation: logging.warning(f"Could not parse '{value_str}' as Decimal."); return default

# --- Input Validation Constants ---
MAX_NAME_LENGTH = 100; MAX_DESC_LENGTH = 255; DATE_FORMAT = '%Y-%m-%d'; MONTH_FORMAT = '%Y-%m'

# --- API Class ---
class Api:
    def __init__(self):
        logging.info("API Initialized")

    # === Settings Methods ===
    def get_theme_preference(self) -> str:
        """Retrieves the saved theme preference from the database."""
        try:
            theme = database.get_setting('theme', 'light') # Default to light
            logging.info(f"API: get_theme_preference returning '{theme}'")
            return api_response(True, data={'theme': theme})
        except Exception as e:
            logging.exception("API: Error getting theme preference")
            return api_response(False, data={'theme': 'light'}, error="Could not retrieve theme preference.")

    def save_theme_preference(self, theme: str) -> str:
        """Saves the chosen theme preference ('light' or 'dark') to the database."""
        if theme not in ['light', 'dark']:
            logging.warning(f"API: Invalid theme value received for saving: '{theme}'")
            return api_response(False, error="Invalid theme value provided ('light' or 'dark' expected).")
        try:
            success = database.set_setting('theme', theme)
            logging.info(f"API: save_theme_preference attempt for '{theme}', Success: {success}")
            if success:
                return api_response(True)
            else: # Error logged by database function
                return api_response(False, error="Failed to save theme preference to database.")
        except Exception as e:
            logging.exception("API: Error saving theme preference")
            return api_response(False, error="An unexpected error occurred while saving theme preference.")
    # === End Settings Methods ===

    # === Account Methods ===
    def get_accounts(self) -> str:
        logging.debug("API: get_accounts called")
        try:
            accounts_processed = database.get_all_accounts_with_balances()
            total_balance = database.get_total_net_balance()
            return api_response(True, data={"accounts": accounts_processed, "total_balance": total_balance})
        except Exception as e: logging.exception("API: Error getting accounts"); return api_response(False, error="Error fetching account data.")

    def add_account(self, name: str, initial_balance_str: Optional[str]) -> str:
        logging.info(f"API: add_account called: name='{name}'")
        try:
            name = str(name).strip();
            if not name: return api_response(False, error="Account name cannot be empty.")
            if len(name) > MAX_NAME_LENGTH: return api_response(False, error=f"Name > {MAX_NAME_LENGTH} chars.")
            balance = _parse_decimal_from_str(initial_balance_str)
            account_id = database.add_account(name, balance)
            if account_id: return api_response(True, data={"new_id": account_id})
            else: return api_response(False, error=f"Failed to add account '{name}'. Name might exist.")
        except Exception as e: logging.exception("API: Error adding account"); return api_response(False, error="Error adding account.")

    def delete_account(self, account_id_str: str) -> str:
        logging.info(f"API: delete_account called for ID: {account_id_str}")
        try:
            acc_id_int = int(account_id_str); deleted = database.delete_account(acc_id_int)
            return api_response(deleted, error=None if deleted else "Account not found.")
        except ValueError: return api_response(False, error="Invalid Account ID.")
        except Exception as e: logging.exception(f"API: Error deleting account {account_id_str}"); return api_response(False, error="Error deleting account.")

    def update_account(self, account_id_str: str, name: str, initial_balance_str: Optional[str]) -> str:
        logging.info(f"API: update_account called: ID={account_id_str}")
        try:
            acc_id_int = int(account_id_str); name = str(name).strip()
            if not name: return api_response(False, error="Account name cannot be empty.")
            if len(name) > MAX_NAME_LENGTH: return api_response(False, error=f"Name > {MAX_NAME_LENGTH} chars.")
            balance = _parse_decimal_from_str(initial_balance_str)
            updated = database.update_account(acc_id_int, name, balance)
            if updated: return api_response(True)
            else:
                exists_check = database.get_accounts() # TODO: Optimize check
                if not any(acc['id'] == acc_id_int for acc in exists_check): return api_response(False, error=f"Account ID {acc_id_int} not found.")
                else: return api_response(False, error="Update failed (name exists or data unchanged?).")
        except ValueError: return api_response(False, error="Invalid Account ID.")
        except Exception as e: logging.exception(f"API: Error updating account {account_id_str}"); return api_response(False, error="Error updating account.")

    # === Transaction Methods ===
    def get_transactions(self, account_id_str: Optional[str] = None, limit_str: Optional[str] = None) -> str:
        logging.debug(f"API: get_transactions (Acc:{account_id_str}, Lim:{limit_str})")
        try:
            account_id = int(account_id_str) if account_id_str and account_id_str != "null" and account_id_str.isdigit() else None
            limit = int(limit_str) if limit_str and limit_str.isdigit() else None
            transactions_raw = database.get_transactions(account_id=account_id, limit=limit)
            transactions = [dict(tran) for tran in transactions_raw] if transactions_raw else []
            return api_response(True, data={"transactions": transactions})
        except ValueError: return api_response(False, error="Invalid account ID or limit format.")
        except Exception as e: logging.exception("API: Error getting transactions"); return api_response(False, error="Error fetching transactions.")

    def add_transaction(self, account_id_str: str, date_str: str, description: str, amount_str: str, category_id_str: Optional[str]) -> str:
        logging.debug(f"API: add_transaction called")
        try:
            account_id_int = int(account_id_str)
            amount = _parse_decimal_from_str(amount_str) # Signed amount from JS
            description = str(description).strip()
            if not description: return api_response(False, error="Description cannot be empty.")
            if len(description) > MAX_DESC_LENGTH: return api_response(False, error=f"Desc > {MAX_DESC_LENGTH} chars.")
            category_id = int(category_id_str) if category_id_str and category_id_str != "null" and category_id_str.isdigit() else None
            date_str = str(date_str).strip()
            try: datetime.datetime.strptime(date_str, DATE_FORMAT)
            except ValueError: return api_response(False, error="Invalid date format (YYYY-MM-DD).")

            transaction_id = database.add_transaction(account_id_int, date_str, description, amount, category_id)
            if transaction_id: return api_response(True, data={"new_id": transaction_id})
            else:
                exists_check = database.get_accounts()
                if not any(acc['id'] == account_id_int for acc in exists_check): return api_response(False, error=f"Account ID {account_id_int} does not exist.")
                else: return api_response(False, error="Database failed to add transaction.")
        except ValueError: return api_response(False, error="Invalid Account/Category ID.")
        except Exception as e: logging.exception("API: Error adding transaction"); return api_response(False, error="Error adding transaction.")

    def delete_transaction(self, transaction_id_str: str) -> str:
        logging.info(f"API: delete_transaction ID: {transaction_id_str}")
        try:
            trans_id_int = int(transaction_id_str); deleted = database.delete_transaction(trans_id_int)
            return api_response(deleted, error=None if deleted else "Transaction not found.")
        except ValueError: return api_response(False, error="Invalid Transaction ID.")
        except Exception as e: logging.exception(f"API: Error deleting tx {transaction_id_str}"); return api_response(False, error="Error deleting transaction.")

    def get_transaction_details(self, transaction_id_str: str) -> str:
        logging.debug(f"API: get_transaction_details ID: {transaction_id_str}")
        try:
            trans_id_int = int(transaction_id_str); transaction = database.get_transaction_by_id(trans_id_int);
            return api_response(True, data={"transaction": dict(transaction)}) if transaction else api_response(False, error="Transaction not found.")
        except ValueError: return api_response(False, error="Invalid Transaction ID.")
        except Exception as e: logging.exception(f"API: Error getting tx details {transaction_id_str}"); return api_response(False, error="Error fetching details.")

    def update_transaction(self, transaction_id_str: str, account_id_str: str, date_str: str, description: str, amount_str: str, category_id_str: Optional[str]) -> str:
        logging.info(f"API: update_transaction ID: {transaction_id_str}")
        try:
            trans_id_int = int(transaction_id_str); account_id_int = int(account_id_str)
            amount = _parse_decimal_from_str(amount_str) # Signed amount
            description = str(description).strip()
            if not description: return api_response(False, error="Description cannot be empty.")
            if len(description) > MAX_DESC_LENGTH: return api_response(False, error=f"Desc > {MAX_DESC_LENGTH} chars.")
            category_id = int(category_id_str) if category_id_str and category_id_str != "null" and category_id_str.isdigit() else None
            date_str = str(date_str).strip()
            try: datetime.datetime.strptime(date_str, DATE_FORMAT)
            except ValueError: return api_response(False, error="Invalid date format (YYYY-MM-DD).")

            updated = database.update_transaction(trans_id_int, account_id_int, date_str, description, amount, category_id)
            return api_response(updated, error=None if updated else "Update failed (check IDs/data).")
        except ValueError: return api_response(False, error="Invalid ID format.")
        except Exception as e: logging.exception(f"API: Error updating tx {transaction_id_str}"); return api_response(False, error="Error updating transaction.")

    # === Category API Methods ===
    def get_categories(self, category_type: Optional[str] = None) -> str:
        logging.debug(f"API: get_categories (type: {category_type})")
        try:
            if category_type is not None and category_type not in ['expense', 'income']: category_type = None
            categories_raw = database.get_categories(category_type=category_type)
            categories = [dict(cat) for cat in categories_raw] if categories_raw else []
            return api_response(True, data={"categories": categories})
        except Exception as e: logging.exception("API: Error getting categories"); return api_response(False, error="Error fetching categories.")

    def add_category(self, name: str, category_type: str = 'expense') -> str:
        logging.info(f"API: add_category (name: {name}, type: {category_type})")
        try:
            name = str(name).strip(); category_type = str(category_type).strip().lower()
            if not name: return api_response(False, error="Category name cannot be empty.")
            if len(name) > MAX_NAME_LENGTH: return api_response(False, error=f"Name > {MAX_NAME_LENGTH} chars.")
            if name.lower() == 'uncategorized': return api_response(False, error="Cannot add 'Uncategorized'.")
            if category_type not in ['expense', 'income']: category_type = 'expense'
            category_id = database.add_category(name, category_type)
            if category_id: return api_response(True, data={"new_id": category_id})
            else: return api_response(False, error=f"Failed to add category '{name}'. Name might exist.")
        except Exception as e: logging.exception("API: Error adding category"); return api_response(False, error="Error adding category.")

    def update_category(self, category_id_str: str, name: str, category_type: str) -> str:
        logging.info(f"API: update_category ID: {category_id_str}")
        try:
            cat_id_int = int(category_id_str)
            updated = database.update_category(cat_id_int, name, category_type)
            return api_response(updated, error=None if updated else "Update failed (check name/type/ID).")
        except ValueError: return api_response(False, error="Invalid Category ID.")
        except Exception as e: logging.exception("API: Error updating category"); return api_response(False, error="Error updating category.")

    def delete_category(self, category_id_str: str) -> str:
        logging.info(f"API: delete_category ID: {category_id_str}")
        try:
            cat_id_int = int(category_id_str); deleted = database.delete_category(cat_id_int);
            return api_response(deleted, error=None if deleted else "Category not found or cannot be deleted.")
        except ValueError: return api_response(False, error="Invalid Category ID.")
        except Exception as e: logging.exception("API: Error deleting category"); return api_response(False, error="Error deleting category.")

    # === Budget API Methods ===
    def get_budget_data_for_month(self, month_str: str) -> str:
        logging.debug(f"API: get_budget_data_for_month M:{month_str}")
        try:
            datetime.datetime.strptime(month_str, MONTH_FORMAT)
            expense_categories = database.get_categories(category_type='expense')
            if not expense_categories: return api_response(True, data={"budget_data": []})
            budgets_raw = database.get_budgets_for_month(month_str)
            budgets_dict: Dict[int, Decimal] = {b['category_id']: b['amount'] for b in budgets_raw}
            budget_data = []
            for cat in expense_categories:
                cat_id = cat['id']; cat_name = cat['name']
                if cat_name.lower() == 'uncategorized': continue
                budget_amount = budgets_dict.get(cat_id, Decimal('0.00'))
                actual_spending = database.get_spending_for_category_month(cat_id, month_str)
                budget_data.append({"category_id": cat_id, "category_name": cat_name, "budgeted_amount": budget_amount, "spent_amount": actual_spending, "remaining_amount": budget_amount - actual_spending})
            budget_data.sort(key=lambda x: x['category_name'])
            return api_response(True, data={"budget_data": budget_data})
        except ValueError: return api_response(False, error=f"Invalid month format: '{month_str}'.")
        except Exception as e: logging.exception("API: Error getting budget data"); return api_response(False, error="Error fetching budget data.")

    def set_budget_amount(self, category_id_str: str, month_str: str, amount_str: str) -> str:
        logging.info(f"API: set_budget C:{category_id_str}, M:{month_str}")
        try:
            cat_id_int = int(category_id_str)
            amount = _parse_decimal_from_str(amount_str); amount = max(Decimal('0.00'), amount)
            datetime.datetime.strptime(month_str, MONTH_FORMAT)
            success = database.set_budget(cat_id_int, month_str, amount)
            return api_response(success, error=None if success else "Set budget failed (check category/type).")
        except ValueError: return api_response(False, error="Invalid ID or month format.")
        except Exception as e: logging.exception("API: Error setting budget"); return api_response(False, error="Error setting budget.")

    # === Reporting API Method ===
    def get_spending_by_category_report(self, start_date_str: str, end_date_str: str) -> str:
        logging.info(f"API: get_spending_by_category_report: {start_date_str} to {end_date_str}")
        try:
            if not start_date_str or not end_date_str: return api_response(False, error="Start/end dates required.")
            start_date = datetime.datetime.strptime(start_date_str, DATE_FORMAT).date()
            end_date = datetime.datetime.strptime(end_date_str, DATE_FORMAT).date()
            if start_date > end_date: return api_response(False, error="Start date after end date.")
            report_data = database.get_spending_by_category(start_date_str, end_date_str)
            return api_response(True, data={"report_data": report_data})
        except ValueError: return api_response(False, error="Invalid date format (YYYY-MM-DD).")
        except Exception as e: logging.exception("API: Error generating spending report"); return api_response(False, error="Error generating report.")

    # === Dashboard Method ===
    def get_dashboard_data(self) -> str:
        logging.debug("API: get_dashboard_data called")
        try:
            accounts = database.get_all_accounts_with_balances()
            recent_tx = [dict(tran) for tran in database.get_transactions(limit=15)]
            current_month = datetime.datetime.now().strftime(MONTH_FORMAT)
            flow_summary = database.get_income_expense_summary_for_month(current_month)
            dashboard_data = {
                "accounts": accounts, "total_balance": database.get_total_net_balance(),
                "account_count": len(accounts), "recent_transactions": recent_tx,
                "monthly_flow": flow_summary['total_income'] - flow_summary['total_expense'],
                "current_month": current_month
            }
            return api_response(True, data=dashboard_data)
        except Exception as e:
            logging.exception("API: Error getting dashboard data")
            empty = {"accounts": [], "total_balance": "0.00", "account_count": 0, "recent_transactions": [], "monthly_flow": "0.00", "current_month": ""}
            return api_response(False, data=empty, error="Error fetching dashboard data.")

    # === Export Method ===
    def export_data_to_excel(self, base_filename: str) -> str:
        logging.info(f"API: export_data_to_excel called: '{base_filename}'")
        safe_base_filename = "".join(c for c in base_filename if c.isalnum() or c in (' ', '_', '-')).rstrip()
        if not safe_base_filename: safe_base_filename = "financxpert_export"
        suggested_filename = f"{safe_base_filename}.xlsx"
        logging.info(f"Suggested save filename: {suggested_filename}")
        try:
            accounts_list = [dict(r) for r in database.get_accounts()]
            transactions_list = [dict(r) for r in database.get_transactions()] # ALL transactions
            categories_list = [dict(r) for r in database.get_categories()]

            accounts_df = pd.DataFrame(accounts_list)[['id', 'name', 'initial_balance']]
            transactions_df = pd.DataFrame(transactions_list)[['id', 'date', 'account_name', 'description', 'category_name', 'amount']]
            categories_df = pd.DataFrame(categories_list)[['id', 'name', 'type']]

            if not webview.windows: logging.error("Export: No active window."); return api_response(False, error="Application window not found.")
            active_window = webview.windows[0]
            result = active_window.create_file_dialog( webview.SAVE_DIALOG, directory='', save_filename=suggested_filename)
            logging.info(f"File dialog result: {result!r} (Type: {type(result)})")

            save_path = None
            if result and isinstance(result, str) and result.strip(): save_path = result
            elif result and isinstance(result, (tuple, list)) and len(result) > 0 and isinstance(result[0], str) and result[0].strip(): save_path = result[0]

            if save_path:
                logging.info(f"Saving export to: {save_path}")
                try:
                    with pd.ExcelWriter(save_path, engine='openpyxl') as writer:
                        transactions_df.to_excel(writer, sheet_name='Transactions', index=False)
                        accounts_df.to_excel(writer, sheet_name='Accounts', index=False)
                        categories_df.to_excel(writer, sheet_name='Categories', index=False)
                    logging.info(f"Export successful: {save_path}")
                    display_path = save_path.replace('\\', '/')
                    return api_response(True, data={"message": f"Data exported to {display_path}"})
                except PermissionError: logging.exception(f"Permission error: {save_path}"); return api_response(False, error=f"Permission denied: Cannot write to '{save_path}'.")
                except Exception as write_error: logging.exception(f"Error writing file: {save_path}"); return api_response(False, error=f"Error writing file: {write_error}")
            else: logging.info("Export cancelled."); return api_response(False, error="Export cancelled.")
        except Exception as e: logging.exception("API: Error during export prep"); return api_response(False, error=f"Error preparing export: {e}")


# --- Main Execution ---
if __name__ == '__main__':
    logging.info("Starting application...")
    try:
        database.initialize_db()
    except Exception as db_init_error:
         logging.critical("CRITICAL: Database initialization failed!", exc_info=True)
         sys.exit(f"Database initialization failed: {db_init_error}")

    api_instance = Api()

    # Determine frontend path
    if getattr(sys, 'frozen', False):
        base_path = Path(sys.executable).parent if not hasattr(sys, '_MEIPASS') else Path(sys._MEIPASS)
    else:
        base_path = Path(__file__).parent # Assumes main.py is in project root

    html_file = base_path / 'web' / 'index.html'
    if not html_file.is_file():
         html_file = base_path / 'index.html' # Fallback to root
    if not html_file.is_file():
         logging.critical(f"CRITICAL: Frontend 'index.html' not found in '{base_path}' or '{base_path / 'web'}'!")
         sys.exit("Frontend file not found.")

    html_file_uri = html_file.resolve().as_uri()
    logging.info(f"Frontend URI: {html_file_uri}")

    # Define window events (optional but good practice)
    def on_loaded(): logging.info("Event: DOM Ready (window.events.loaded).")
    def on_closing(): logging.info("Event: WebView closing.")
    def on_shown(): logging.info("Event: WebView shown.")

    window = webview.create_window(
        'FinancXpert',
        html_file_uri,
        js_api=api_instance, # Pass the instance here
        width=1280, height=800, resizable=True, min_size=(1000, 650), confirm_close=False
    )

    # Attach events after window creation
    window.events.loaded += on_loaded
    window.events.closing += on_closing
    window.events.shown += on_shown

    # Start the event loop
    logging.info("Starting pywebview event loop...")
    webview.start(debug=False) # debug=True enables dev tools

    logging.info("Application finished.")