import os
import subprocess
import sys

def run_script(script_path):
    print(f"\n>>> Running {script_path}...")
    try:
        # Use sys.executable to ensure we use the same python interpreter
        subprocess.run([sys.executable, script_path], check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error running {script_path}: {e}")
        return False
    return True

def main():
    # 1. Extraction (cams.py)
    # Note: cams.py currently has hardcoded paths. 
    # In a real scenario, we might want to pass them as arguments.
    if not run_script('cams.py'):
        print("Pipeline failed at extraction step.")
        return

    # 2. Processing (processor.py)
    if not run_script('processor.py'):
        print("Pipeline failed at processing step.")
        return

    # 3. Analytics (analytics.py)
    if not run_script('analytics.py'):
        print("Pipeline failed at analytics step.")
        return

    print("\n" + "="*40)
    print("PIPELINE COMPLETED SUCCESSFULLY!")
    print("Run 'python app.py' to view the dashboard at http://localhost:5000")
    print("="*40)

if __name__ == "__main__":
    main()
