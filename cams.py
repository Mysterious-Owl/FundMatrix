import pandas as pd
import pdfplumber
import re
from os import path
import os
import numpy as np

def file_processing(file_path, doc_pwd, txt_file):
    """
    Processes a password-protected PDF file, extracts its text content, and writes it to a text file.

    Args:
        file_path (str): The path to the PDF file to be processed.
        doc_pwd (str): The password for the PDF file.
        txt_file (str): The path to the output text file where the extracted text will be saved.

    Returns:
        str: The complete extracted text from the PDF file.
    """
    final_text = ""
    with pdfplumber.open(file_path, password=doc_pwd) as pdf:
        text_list = []
        for i in range(len(pdf.pages)):
            txt = pdf.pages[i].extract_text()
            text_list.append(txt)
        final_text = "\n".join(text_list)
    
    # Ensure directory for txt_file exists
    os.makedirs(os.path.dirname(txt_file), exist_ok=True)
    with open(txt_file, 'w') as f:
        f.write(final_text)
    return final_text


def extract_text(txt_file, final_csv):
    with open(txt_file, 'r') as f:
        doc_txt = f.read()

    # Defining RegEx patterns
    folio_pat = re.compile(r"(^Folio No:\s\d+?)", flags=re.IGNORECASE)
    # Extracting Folio information
    fund_name = re.compile(r".*[Fund].*ISIN.*", flags=re.IGNORECASE)
    trans_details = re.compile(
        r"(^\d{2}-\w{3}-\d{4})(\s.+?\s(?=[\d(]))([\d(]+[,.]\d+[.\d)]+)(\s[\d(,.)]+)(\s[\d,.]+)(\s[\d,.]+)"
    )

    # Extracting Transaction data
    line_items = []
    fun_name = folio = ""
    for i in doc_txt.splitlines():
        if fund_name.match(i):
            fun_name = i
        if folio_pat.match(i):
            folio = i

        txt = trans_details.search(i)
        if txt:
            line_items.append({
                "Folio": folio,
                "Fund_name": fun_name,
                "Date": txt.group(1),
                "Remarks": txt.group(2),
                "Amount": txt.group(3),
                "Units": txt.group(4),
                "Price": txt.group(5),
                "Unit_balance": txt.group(6)
            })

    if not line_items:
        print("No transactions found in PDF.")
        return False

    df = pd.DataFrame(line_items)
    df = formatter(df)
    save_data(df, final_csv)
    return True

def save_data(df, final_csv):
    if path.isfile(final_csv):
        old_df = pd.read_csv(final_csv)
        old_df['Date'] = pd.to_datetime(old_df['Date'], format='mixed')
        min_date = df['Date'].min()
        old_df = old_df[old_df['Date'] < min_date]
        df = pd.concat([old_df, df])
    
    # Ensure directory for final_csv exists
    os.makedirs(os.path.dirname(final_csv), exist_ok=True)
    df.sort_values('Date', ascending=False).to_csv(final_csv, index=False)


def formatter(df):
    def clean_txt(x: pd.Series):
        x = x.astype(str)
        x = x.str.replace(r",", "", regex=True)
        x = x.str.replace(r"\(", "-", regex=True)
        x = x.str.replace(r"\)", "", regex=True)
        return x

    def name_cleaner(x: str):
        try:
            match = re.findall(r'-(.+)isin', x.lower())
            if not match: 
                return x.title()
            x = match[0]
            len_con = lambda i: len(x) if i == -1 else i
            keywords = ['direct', 'growth', 'growth plan']
            indexs = [len_con(x.rfind(i)) for i in keywords]
            x = x[:min(indexs)]
            while x and x[-1] in (' ', '-', ' '):
                x = x[:-1]
            x = x.title()
            to_capitalize = ['Bse', 'Fof', 'Us', 'Sbi']
            for i in to_capitalize:
                x = x.replace(i, i.upper())
            return x
        except:
            return str(x).title()

    invst_type_mapper = {
        '.*sys.*': 'SIP',
        '.*redemption.*': 'Redemption',
        '.*purchase.*': 'Lumpsum'
    }
    fund_type_mapper = {
        '.*idcw.*': 'IDCW',
        '.*growth.*': 'Growth'
    }
    invst_channel_mapper = {
        '.*direct.*': 'Direct',
        '.*regular.*': 'Regular'
    }
    amc_mapper = {
        '.*axis.*': 'Axis',
        '.*sbi.*': 'SBI',
        '.*nippon.*': 'Nippon',
        '.*quant.*': 'Quant',
        '.*bharat.*': 'Edelweiss',
        '.*edelweiss.*': 'Edelweiss',
        '.*aditya.*': 'Aditya Birla',
        '.*parag.*': 'Parag Parikh',
        '.*uti.*': 'UTI',
        '.*motilal.*': 'Motilal Oswal',
        '.*icici.*': 'ICICI Prudential',
        '.*hdfc.*': 'HDFC',
        '.*jio.*': 'Jio'
    }
    advisor_mapper = {
        'INZ000240532': 'Paytm Money',
        'INZ000006031': 'Dhan'
    }

    df['Amount'] = clean_txt(df.Amount)
    df['Units'] = clean_txt(df.Units)
    df['Price'] = clean_txt(df.Price)
    df['Unit_balance'] = clean_txt(df.Unit_balance)
    
    df = df.astype({
        "Amount": "float",
        "Units": "float",
        "Price": "float",
        "Unit_balance": "float"
    })
    df['Date'] = pd.to_datetime(df['Date'], format='%d-%b-%Y')
    df['Name'] = df['Fund_name'].apply(name_cleaner)
    df['Investment Type'] = df.Remarks.str.lower().replace(invst_type_mapper, regex=True)
    df['Fund Type'] = df.Fund_name.str.lower().replace(fund_type_mapper, regex=True)
    df.loc[df['Fund_name'].str.lower() == df['Fund Type'], 'Fund Type'] = 'Growth'
    df['Investment Channel'] = df.Fund_name.str.lower().replace(invst_channel_mapper, regex=True)
    df.loc[df['Fund_name'].str.lower() == df['Investment Channel'], 'Investment Channel'] = 'Direct'
    df['Folio No'] = df['Folio'].str.extract(r'Folio No: (\d*) ')
    df['ISIN'] = df['Fund_name'].str.extract(r'ISIN[ :]+(\w+)[( ]')
    df['Advisor'] = df['Fund_name'].str.extract(r'Advisor[ :]+(\w+)[( )]')
    df.loc[df['Advisor'].str.lower() == 'registrar', 'Advisor'] = np.nan
    df['AMC'] = df.Fund_name.str.lower().replace(amc_mapper, regex=True)
    df['Advisor Name'] = df.Advisor.replace(advisor_mapper)

    df.drop(['Folio', 'Fund_name'], axis=1, inplace=True)
    df = df[['Name', 'Date', 'Amount', 'Units', 'Price', 'Unit_balance', 'Investment Type', 'Fund Type',
             'Investment Channel', 'Folio No', 'ISIN', 'Advisor', 'Advisor Name', 'AMC', 'Remarks']]

    return df

def process_cams_pdf(pdf_path, password, txt_path='data/temp_cams.txt', csv_path='data/cams_mf.csv'):
    try:
        if not os.path.exists(pdf_path): 
            return False, "PDF not found"
        file_processing(pdf_path, password, txt_path)
        success = extract_text(txt_path, csv_path)
        if success: 
            return True, "Processed successfully"
        return False, "No data extracted"
    except Exception as e:
        return False, str(e)

if __name__ == "__main__":
    # Internal test/CLI usage
    cams = r"cas_pdf/.pdf"
    cams_pwd = "qwerty@12345"
    if os.path.exists(cams):
        s, m = process_cams_pdf(cams, cams_pwd)
        print(m)
