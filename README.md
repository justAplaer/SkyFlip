## Running SkyFlip on Windows

### Prerequisites

Install:

- Python 3.11
- Node.js and npm

### First-time setup

1. Extract the SkyFlip ZIP file.
2. Open the extracted project folder—the one containing both `backend` and `frontend`.
3. Click the folder’s address bar, type `powershell`, and press Enter.

In the PowerShell window, create a Python virtual environment:

```powershell
py -3.11 -m venv .venv
```

Install the backend dependencies:

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Install the frontend dependencies:

```powershell
cd frontend
npm install
cd ..
```

### Starting the application

You need two PowerShell windows: one for the backend and one for the frontend.

**Terminal 1 — backend**

Open PowerShell in the project folder and run:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Wait until you see `Application startup complete`. Leave this window open.

**Terminal 2 — frontend**

Open another PowerShell window in the project folder and run:

```powershell
cd frontend
npm run dev
```

Open the **Local** address displayed in the terminal, usually:

```text
http://localhost:5173
```

Keep both terminals open while using SkyFlip. To stop the application, press `Ctrl + C` in each terminal.

### Using the image viewer

Below the image, use the **View** menu to choose **Full image** or **Cutout**. Click **Request new batch of 10** to retrieve a new batch. The counter shows how many images have finished processing.

Full images require access to the live archive. If the archive is unavailable, the application will show an error or identify a cached cutout when one is available.

### Troubleshooting

- **`py` is not recognized:** Reinstall Python and enable the Python launcher, or use the full path to your Python executable to create the virtual environment.
- **`npm` is not recognized:** Install Node.js, close PowerShell, and open a new terminal.
- **Port 8000 or 5173 is already in use:** Stop any older SkyFlip servers and run the startup command again.
- **The page says “Failed to fetch”:** Check that both terminals are still running and that the backend says `Application startup complete`.
- **The browser shows an older version:** Close old SkyFlip servers, open the address printed by the current frontend terminal, and press `Ctrl + Shift + R`.