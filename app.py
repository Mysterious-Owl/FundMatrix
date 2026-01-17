from flask import Flask, render_template, jsonify, request
import json
import os
import pandas as pd
import threading
from datetime import datetime
from werkzeug.utils import secure_filename

# Import our custom modules
import processor
import analytics
import cams

app = Flask(__name__)

# CONFIGURATION
DATA_FILE = 'data/dashboard_data.json'
UPLOAD_FOLDER = 'cas_pdf'
EXTERNAL_URL = "https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement" # Configurable URL
PDF_PASSWORD = "qwerty@12345" # Configurable password
ALLOWED_EXTENSIONS = {'pdf'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def run_pipeline(force_nav=False, new_pdf=None, password=None):
    """Orchestrates the data processing pipeline."""
    try:
        # 1. Extraction (only if new PDF provided)
        if new_pdf:
            if not password: return False, "Password required for PDF"
            success, msg = cams.process_cams_pdf(new_pdf, password)
            if not success: return False, f"CAS Error: {msg}"

        # 2. Processing (NAV and FIFO)
        processor.process_mf_data('data/cams_mf.csv', 'data/mf_gains_v2.csv', 'data/realized_gains.csv', force_refresh=force_nav)

        # 3. Analytics
        data = analytics.calculate_analytics('data/mf_gains_v2.csv', 'data/realized_gains.csv', 'data/full_nav_history.csv', 'data/mf-props.csv')
        if data:
            with open(DATA_FILE, 'w') as f: json.dump(data, f, indent=4)
        
        return True, "Pipeline completed successfully"
    except Exception as e:
        return False, str(e)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/data')
def get_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r') as f:
            data = json.load(f)
        return jsonify(data)
    else:
        # Try running pipeline if data is missing
        success, msg = run_pipeline()
        if success:
             with open(DATA_FILE, 'r') as f:
                data = json.load(f)
             return jsonify(data)
        return jsonify({"error": "Data file not found and initial processing failed"}), 404

@app.route('/api/config')
def get_config():
    return jsonify({
        "external_url": EXTERNAL_URL
    })

@app.route('/api/refresh/nav', methods=['POST'])
def refresh_nav():
    success, msg = run_pipeline(force_nav=True)
    if success: return jsonify({"status": "success", "message": msg})
    return jsonify({"status": "error", "message": msg}), 500

@app.route('/api/refresh/data', methods=['POST'])
def refresh_data():
    success, msg = run_pipeline()
    if success: return jsonify({"status": "success", "message": msg})
    return jsonify({"status": "error", "message": msg}), 500

@app.route('/settings')
def settings():
    return render_template('settings.html')

@app.route('/api/mf-props', methods=['GET', 'POST'])
def handle_mf_props():
    props_path = 'data/mf-props.csv'
    if request.method == 'GET':
        if not os.path.exists(props_path):
            return jsonify([])
        df = pd.read_csv(props_path)
        # Handle NaN for valid JSON
        df = df.fillna("")
        return jsonify(df.to_dict('records'))
    else:
        # POST: Update or Append
        data = request.json
        df = pd.DataFrame(data)
        df.to_csv(props_path, index=False)
        return jsonify({"status": "success"})

@app.route('/api/indices', methods=['GET', 'POST'])
def handle_indices():
    indices_path = 'data/indices.csv'
    if request.method == 'GET':
        if not os.path.exists(indices_path):
            return jsonify([])
        df = pd.read_csv(indices_path)
        # Handle NaN for valid JSON
        df = df.fillna("")
        return jsonify(df.to_dict('records'))
    else:
        # POST: Update full list
        data = request.json
        df = pd.DataFrame(data)
        df.to_csv(indices_path, index=False)
        return jsonify({"status": "success"})

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No selected file"}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Append timestamp to avoid collision
        filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(file_path)
        
        password = request.form.get('password')
        
        # Run full pipeline with new file and user password
        success, msg = run_pipeline(new_pdf=file_path, password=password)
        if success: return jsonify({"status": "success", "message": msg})
        return jsonify({"status": "error", "message": msg}), 500
    
    return jsonify({"status": "error", "message": "File type not allowed"}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)
