const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// ID Folder Utama (Parent Folder) Google Drive
const PARENT_FOLDER_ID = '1t794FUtntfHIyKrXPRUtYeXQqoJIojpu';

/**
 * Konfigurasi Otentikasi Google Service Account
 * Membaca dari Environment Variable (Hosting) atau File Lokal (Komputer)
 */
let auth;

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  // Jika di-hosting di Koyeb/Render/Railway (membaca dari Environment Variable)
  console.log('🔒 Menggunakan kredensial Google dari Environment Variable');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
} else {
  // Jika dijalankan secara lokal di komputer (membaca file service-account.json)
  const KEYFILEPATH = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(KEYFILEPATH)) {
    console.log('📁 Menggunakan kredensial dari file lokal service-account.json');
    auth = new google.auth.GoogleAuth({
      keyFile: KEYFILEPATH,
      scopes: SCOPES,
    });
  } else {
    console.error('❌ ERROR: Kredensial Google Service Account tidak ditemukan!');
    process.exit(1);
  }
}

const drive = google.drive({ version: 'v3', auth });

// Melayani file statis dari folder 'public'
app.use(express.static('public'));

// Cache lokal untuk struktur folder dan log aktivitas
let rawFolderCache = []; 
let processedFiles = new Set();
let uploadLogs = [];

// Default periode monitoring (fallback)
let activePeriod = {
  startDate: '2026-10-07',
  endDate: '2026-10-09'
};

/**
 * Helper: Memeriksa apakah createdTime file berada
 * tepat di dalam rentang startDate (00:00:00) s/d endDate (23:59:59)
 */
function isFileInDateRange(createdTimeStr, startDateStr, endDateStr) {
  const fileDate = new Date(createdTimeStr);

  const start = new Date(startDateStr);
  start.setHours(0, 0, 0, 0);

  const end = new Date(endDateStr);
  end.setHours(23, 59, 59, 999);

  return fileDate >= start && fileDate <= end;
}

/**
 * Pemindaian Google Drive API ke Memory Cache secara Rekursif
 */
async function fetchDriveDataRecursive(folderId, parentPath = '') {
  let nodes = [];

  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, webViewLink, createdTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000
    });

    const items = res.data.files || [];
    const subFolders = items.filter(item => item.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(item => item.mimeType !== 'application/vnd.google-apps.folder');

    // Catat notifikasi file baru secara real-time
    files.forEach((file) => {
      if (!processedFiles.has(file.id)) {
        processedFiles.add(file.id);

        const fileData = {
          id: file.id,
          name: file.name,
          userName: parentPath || 'Unit/Pengguna',
          link: file.webViewLink,
          createdTime: file.createdTime,
          time: new Date(file.createdTime).toLocaleString('id-ID'),
        };

        uploadLogs.unshift(fileData);
        io.emit('new_file_notification', fileData);
      }
    });

    if (subFolders.length > 0) {
      // Telusuri sub-folder secara berjenjang
      for (const subFolder of subFolders) {
        const currentPath = parentPath ? `${parentPath} > ${subFolder.name}` : subFolder.name;
        const results = await fetchDriveDataRecursive(subFolder.id, currentPath);
        nodes = nodes.concat(results);
      }
    } else {
      // Jika tidak ada sub-folder lagi, simpan unit ke memori cache
      if (parentPath) {
        nodes.push({
          id: folderId,
          name: parentPath,
          files: files.map(f => ({ id: f.id, createdTime: f.createdTime }))
        });
      }
    }
  } catch (error) {
    console.error(`❌ Error fetching folder (${folderId}):`, error.message);
  }

  return nodes;
}

/**
 * Kalkulasi Statistik Instan Langsung dari Cache Memori
 */
function evaluateStatsFromCache(startDateStr, endDateStr) {
  const allUserFolders = rawFolderCache.map(unit => {
    // Filter file milik unit ini yang berada dalam periode terpilih
    const validFiles = unit.files.filter(f => isFileInDateRange(f.createdTime, startDateStr, endDateStr));
    
    return {
      id: unit.id,
      name: unit.name,
      fileCount: validFiles.length,
      hasUploaded: validFiles.length > 0
    };
  });

  const uploadedUsers = allUserFolders.filter(u => u.hasUploaded);
  const notUploadedUsers = allUserFolders.filter(u => !u.hasUploaded);

  return {
    startDate: startDateStr,
    endDate: endDateStr,
    totalMaster: allUserFolders.length,
    uploadedCount: uploadedUsers.length,
    notUploadedCount: notUploadedUsers.length,
    hasUploaded: uploadedUsers,
    hasNotUploaded: notUploadedUsers,
  };
}

/**
 * Pembaruan Google Drive Cache di Background
 */
async function refreshDriveCache() {
  console.log(`🔄 Syncing Google Drive data ke cache...`);
  const freshData = await fetchDriveDataRecursive(PARENT_FOLDER_ID);
  
  if (freshData && freshData.length > 0) {
    rawFolderCache = freshData;
    console.log(`✅ Sync Selesai. Total ${rawFolderCache.length} unit tersimpan di cache.`);
    
    // Broadcast pembaruan statistik ke seluruh client
    const statsData = evaluateStatsFromCache(activePeriod.startDate, activePeriod.endDate);
    io.emit('stats_update', statsData);
  }
}

// Inisialisasi Socket.io Connection
io.on('connection', (socket) => {
  console.log('⚡ Client terhubung:', socket.id);
  
  socket.emit('initial_logs', uploadLogs);

  // Kirim data langsung dari cache jika tersedia
  if (rawFolderCache.length > 0) {
    const statsData = evaluateStatsFromCache(activePeriod.startDate, activePeriod.endDate);
    socket.emit('stats_update', statsData);
  }

  // Respon instan saat client memilih periode tanggal di dropdown
  socket.on('change_target_date', (periodData) => {
    if (periodData && periodData.startDate && periodData.endDate) {
      activePeriod = {
        startDate: periodData.startDate,
        endDate: periodData.endDate
      };

      console.log(`⚡ INSTANT FILTER [${activePeriod.startDate} s/d ${activePeriod.endDate}] diproses dari cache.`);
      
      const statsData = evaluateStatsFromCache(activePeriod.startDate, activePeriod.endDate);
      socket.emit('stats_update', statsData);
    }
  });
});

// Sinkronisasi awal saat server berjalan
refreshDriveCache();

// Polling background sync setiap 10 detik
setInterval(() => {
  refreshDriveCache();
}, 10000);

// Jalankan Express & HTTP Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Server Monitoring berjalan di port ${PORT}`);
  console.log(`===================================================`);
});
