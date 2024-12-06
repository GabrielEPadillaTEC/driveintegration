const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const multer = require('multer');
const upload = multer();

require('dotenv').config();

// Load environment variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Firebase setup
const serviceAccount = require('./firebase-adminsdk.json');
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: 'https://driveintegrationsoa-default-rtdb.firebaseio.com/',
});
const db = getDatabase();

// Google OAuth setup
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Express setup
const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: '*' }));

// Generate OAuth URL
app.get('/auth/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });
  res.json({ url: authUrl });
});


app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log("yep");
    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    console.log("yep2");
    const userInfo = await oauth2.userinfo.get();
    console.log("yep3");
    const userId = userInfo.data.id; // Unique ID for the user
    console.log("yep4");
    // Store tokens in Firebase under the user ID
    await db.ref(`users/${userId}/tokens`).set(tokens);
    console.log("yep5");
    // Redirect to the frontend dashboard with the user ID
    const frontendDashboardUrl = `https://driveintegrationsoa.web.app/dashboard.html?userId=${userId}`;
    console.log("yep6");
    res.redirect(frontendDashboardUrl);
  } catch (error) {
    console.log("yeppers");
    console.error('Error during OAuth callback:', error);
    res.status(500).send('Authentication failed.');
  }
});


app.get('/drive/folders', async (req, res) => {
  const userId = req.query.userId; // Get the user ID from the query
  if (!userId) return res.status(400).send('User ID is required');

  try {
    // Retrieve user tokens from Firebase
    const tokens = (await db.ref(`users/${userId}/tokens`).get()).val();
    oauth2Client.setCredentials(tokens);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder'",
      //fields: 'files(id, name)',
      fields: 'files(id, name, parents)',
    });

    const folders = response.data.files;

    // Save folder metadata in Firebase under the user ID
    folders.forEach(folder => {
      db.ref(`users/${userId}/folders/${folder.id}`).set({
        id: folder.id,
        description: folder.name,
        parents: folder.parents || [],
      });
    });

    res.json(folders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/folders/:id', async (req, res) => {
  const userId = req.query.userId;
  const folderId = req.params.id;

  if (!userId || !folderId) return res.status(400).send('User ID and Folder ID are required');

  try {
    const tokens = (await db.ref(`users/${userId}/tokens`).get()).val();
    oauth2Client.setCredentials(tokens);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: 'files(id, name, mimeType)',
    });

    const files = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      type: file.mimeType.includes('folder') ? 'folder' : 'file',
    }));

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create folder
app.post('/drive/folders', async (req, res) => {
  const { name } = req.body;
  try {
    const userInfo = await oauth2.userinfo.get();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folderMetadata = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    const response = await drive.files.create({
      requestBody: folderMetadata,
      fields: 'id',
    });
    const folderId = response.data.id;

    // Save folder metadata in Firebase
    await db.ref(`folders/${folderId}`).set({
      id: folderId,
      description: name,
    });

    res.json({ folderId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// Upload file
app.post('/drive/upload', upload.single('file'), async (req, res) => {
  const { name, mimeType, folderId, description, userId } = req.body;

  // Validate inputs
  if (!userId) {
    return res.status(400).send('User ID is required.');
  }
  if (!req.file) {
    return res.status(400).send('File is required.');
  }
  if (!name || !mimeType) {
    return res.status(400).send('File name and MIME type are required.');
  }

  try {
    // Retrieve user tokens from Firebase
    const tokens = (await db.ref(`users/${userId}/tokens`).get()).val();
    if (!tokens) {
      return res.status(403).send('User is not authenticated.');
    }
    oauth2Client.setCredentials(tokens);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // File metadata for Google Drive
    const fileMetadata = {
      name,
      parents: folderId ? [folderId] : [], // If a folder ID is provided, nest the file inside
    };

    // Media data for Google Drive
    const media = {
      mimeType,
      body: req.file.buffer, // Use the buffer from multer for the file stream
    };

    // Upload file to Google Drive
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id',
    });

    const fileId = response.data.id;

    // Save file metadata in Firebase under the user's namespace
    await db.ref(`users/${userId}/files/${fileId}`).set({
      id: fileId,
      description,
      parent: folderId || null,
      name,
      mimeType,
    });

    res.json({ fileId, message: 'File uploaded successfully.' });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: error.message });
  }
});


//Download
app.get('/drive/files/:id/download', async (req, res) => {
  const fileId = req.params.id;
  const userId = req.query.userId;

  if (!fileId || !userId) return res.status(400).send('File ID and User ID are required');

  try {
    const tokens = (await db.ref(`users/${userId}/tokens`).get()).val();
    oauth2Client.setCredentials(tokens);

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${fileId}"`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

//pfp info
app.get('/user/profile', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).send('User ID is required');

  try {
    const tokens = (await db.ref(`users/${userId}/tokens`).get()).val();
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    res.json({
      name: userInfo.data.name,
      picture: userInfo.data.picture,
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Error fetching user profile' });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
