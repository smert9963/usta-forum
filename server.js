const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/mercedes_forum";

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* =========================
   MONGODB CONNECTION
========================= */
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("MongoDB bağlandı");
  })
  .catch((err) => {
    console.log("MongoDB hata:", err);
  });

/* =========================
   UPLOAD SETTINGS
========================= */
const uploadDir = path.join(__dirname, "public", "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Sadece JPG, PNG veya WEBP yüklenebilir."));
    }
    cb(null, true);
  }
});

/* =========================
   SCHEMAS
========================= */
const commentSchema = new mongoose.Schema(
  {
    authorName: String,
    authorService: String,
    text: String
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    vehicle: String,
    title: String,
    description: String,
    category: String,
    authorName: String,
    authorService: String,
    image: String,
    solved: {
      type: Boolean,
      default: false
    },
    comments: {
      type: [commentSchema],
      default: []
    }
  },
  { timestamps: true }
);

postSchema.index({ category: 1 });
postSchema.index({ vehicle: 1 });
postSchema.index({ createdAt: -1 });
postSchema.index({ solved: 1 });

const userSchema = new mongoose.Schema(
  {
    fullName: String,
    username: { type: String, unique: true, required: true },
    password: String,
    service: String,
    city: String,
    isAdmin: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

userSchema.index({ username: 1 }, { unique: true });

const Post = mongoose.model("Post", postSchema);
const User = mongoose.model("User", userSchema);

/* =========================
   HELPER
========================= */
async function getUserByUsername(username) {
  if (!username) return null;
  return await User.findOne({ username });
}

function deleteImageIfExists(imagePathFromDb) {
  if (!imagePathFromDb) return;

  const cleanPath = imagePathFromDb.replace(/^\/+/, "");
  const fullPath = path.join(__dirname, "public", cleanPath);

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

/* =========================
   AUTH
========================= */
app.post("/register", async (req, res) => {
  try {
    const { fullName, username, password, service, city } = req.body;

    if (!fullName || !username || !password || !service || !city) {
      return res.json({
        success: false,
        message: "Tüm alanları doldur."
      });
    }

    const cleanUsername = username.trim();

    const existingUser = await User.findOne({ username: cleanUsername });

    if (existingUser) {
      return res.json({
        success: false,
        message: "Bu kullanıcı adı zaten var."
      });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);

    const newUser = new User({
      fullName: fullName.trim(),
      username: cleanUsername,
      password: hashedPassword,
      service: service.trim(),
      city: city.trim(),
      isAdmin: false
    });

    await newUser.save();

    res.json({
      success: true,
      message: "Kayıt başarılı."
    });
  } catch (error) {
    console.log("Register hata:", error);
    res.status(500).json({
      success: false,
      message: "Kayıt işlemi başarısız."
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({
        success: false,
        message: "Kullanıcı adı ve şifre gir."
      });
    }

    const user = await User.findOne({
      username: username.trim()
    });

    if (!user) {
      return res.json({
        success: false,
        message: "Kullanıcı adı veya şifre yanlış."
      });
    }

    const match = await bcrypt.compare(password.trim(), user.password);

    if (!match) {
      return res.json({
        success: false,
        message: "Kullanıcı adı veya şifre yanlış."
      });
    }

    res.json({
      success: true,
      message: "Giriş başarılı.",
      user: {
        _id: user._id,
        fullName: user.fullName,
        username: user.username,
        service: user.service,
        city: user.city,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.log("Login hata:", error);
    res.status(500).json({
      success: false,
      message: "Giriş işlemi başarısız."
    });
  }
});

/* =========================
   STATS
========================= */
app.get("/stats", async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalPosts = await Post.countDocuments();
    const solvedPosts = await Post.countDocuments({ solved: true });

    res.json({
      totalUsers,
      totalPosts,
      solvedPosts
    });
  } catch (error) {
    console.log("Stats hata:", error);
    res.status(500).json({
      success: false,
      message: "İstatistik alınamadı."
    });
  }
});

/* =========================
   POSTS
========================= */
app.get("/posts", async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const posts = await Post.find()
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit);

    res.json(posts);
  } catch (error) {
    console.log("Posts get hata:", error);
    res.status(500).json({
      success: false,
      message: "Postlar alınamadı."
    });
  }
});

app.post("/posts", upload.single("image"), async (req, res) => {
  try {
    const {
      vehicle,
      title,
      description,
      category,
      authorName,
      authorService
    } = req.body;

    if (
      !vehicle ||
      !title ||
      !description ||
      !category ||
      !authorName ||
      !authorService
    ) {
      return res.json({
        success: false,
        message: "Eksik bilgi var."
      });
    }

    const newPost = new Post({
      vehicle: vehicle.trim(),
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      authorName: authorName.trim(),
      authorService: authorService.trim(),
      image: req.file ? `/uploads/${req.file.filename}` : "",
      solved: false,
      comments: []
    });

    await newPost.save();

    io.emit("newPost", {
      _id: newPost._id,
      vehicle: newPost.vehicle,
      title: newPost.title,
      authorName: newPost.authorName,
      authorService: newPost.authorService
    });

    res.json({
      success: true,
      message: "Post eklendi.",
      post: newPost
    });
  } catch (error) {
    console.log("Post ekleme hata:", error);
    res.status(500).json({
      success: false,
      message: "Post eklenemedi."
    });
  }
});

app.post("/comment/:id", async (req, res) => {
  try {
    const { authorName, authorService, text } = req.body;
    const { id } = req.params;

    if (!authorName || !authorService || !text) {
      return res.json({
        success: false,
        message: "Yorum bilgileri eksik."
      });
    }

    const post = await Post.findById(id);

    if (!post) {
      return res.json({
        success: false,
        message: "Post bulunamadı."
      });
    }

    const newComment = {
      authorName: authorName.trim(),
      authorService: authorService.trim(),
      text: text.trim()
    };

    post.comments.push(newComment);
    await post.save();

    io.emit("newComment", {
      postId: post._id,
      postTitle: post.title,
      vehicle: post.vehicle,
      authorName: newComment.authorName,
      authorService: newComment.authorService,
      text: newComment.text
    });

    res.json({
      success: true,
      message: "Yorum eklendi."
    });
  } catch (error) {
    console.log("Yorum hata:", error);
    res.status(500).json({
      success: false,
      message: "Yorum eklenemedi."
    });
  }
});

/* =========================
   SOLVE
========================= */
app.post("/solve/:id", async (req, res) => {
  try {
    const { username } = req.body;
    const { id } = req.params;

    const user = await getUserByUsername(username);

    if (!user || !user.isAdmin) {
      return res.json({
        success: false,
        message: "Bu işlem sadece admin tarafından yapılabilir."
      });
    }

    const post = await Post.findById(id);

    if (!post) {
      return res.json({
        success: false,
        message: "Post bulunamadı."
      });
    }

    post.solved = true;
    await post.save();

    res.json({
      success: true,
      message: "Konu çözüldü olarak işaretlendi."
    });
  } catch (error) {
    console.log("Solve hata:", error);
    res.status(500).json({
      success: false,
      message: "İşlem başarısız."
    });
  }
});

/* =========================
   ADMIN
========================= */
app.post("/admin/users", async (req, res) => {
  try {
    const { username } = req.body;
    const adminUser = await getUserByUsername(username);

    if (!adminUser || !adminUser.isAdmin) {
      return res.json({
        success: false,
        message: "Yetkisiz işlem."
      });
    }

    const users = await User.find({}, { password: 0 }).sort({
      username: 1,
      _id: 1
    });

    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.log("Admin users hata:", error);
    res.status(500).json({
      success: false,
      message: "Kullanıcılar alınamadı."
    });
  }
});

app.post("/admin/toggle-admin/:id", async (req, res) => {
  try {
    const { username } = req.body;
    const { id } = req.params;

    const adminUser = await getUserByUsername(username);

    if (!adminUser || !adminUser.isAdmin) {
      return res.json({
        success: false,
        message: "Yetkisiz işlem."
      });
    }

    const targetUser = await User.findById(id);

    if (!targetUser) {
      return res.json({
        success: false,
        message: "Kullanıcı bulunamadı."
      });
    }

    targetUser.isAdmin = !targetUser.isAdmin;
    await targetUser.save();

    res.json({
      success: true,
      message: targetUser.isAdmin
        ? "Kullanıcı admin yapıldı."
        : "Admin yetkisi kaldırıldı."
    });
  } catch (error) {
    console.log("Toggle admin hata:", error);
    res.status(500).json({
      success: false,
      message: "Yetki güncellenemedi."
    });
  }
});

app.post("/admin/delete-user/:id", async (req, res) => {
  try {
    const { username } = req.body;
    const { id } = req.params;

    const adminUser = await getUserByUsername(username);

    if (!adminUser || !adminUser.isAdmin) {
      return res.json({
        success: false,
        message: "Yetkisiz işlem."
      });
    }

    if (String(adminUser._id) === String(id)) {
      return res.json({
        success: false,
        message: "Kendi hesabını silemezsin."
      });
    }

    const deleted = await User.findByIdAndDelete(id);

    if (!deleted) {
      return res.json({
        success: false,
        message: "Kullanıcı bulunamadı."
      });
    }

    res.json({
      success: true,
      message: "Kullanıcı silindi."
    });
  } catch (error) {
    console.log("Delete user hata:", error);
    res.status(500).json({
      success: false,
      message: "Kullanıcı silinemedi."
    });
  }
});

app.post("/admin/posts", async (req, res) => {
  try {
    const { username } = req.body;
    const adminUser = await getUserByUsername(username);

    if (!adminUser || !adminUser.isAdmin) {
      return res.json({
        success: false,
        message: "Yetkisiz işlem."
      });
    }

    const posts = await Post.find().sort({ createdAt: -1, _id: -1 });

    res.json({
      success: true,
      posts
    });
  } catch (error) {
    console.log("Admin posts hata:", error);
    res.status(500).json({
      success: false,
      message: "Postlar alınamadı."
    });
  }
});

app.post("/admin/delete-post/:id", async (req, res) => {
  try {
    const { username } = req.body;
    const { id } = req.params;

    const adminUser = await getUserByUsername(username);

    if (!adminUser || !adminUser.isAdmin) {
      return res.json({
        success: false,
        message: "Yetkisiz işlem."
      });
    }

    const post = await Post.findById(id);

    if (!post) {
      return res.json({
        success: false,
        message: "Post bulunamadı."
      });
    }

    if (post.image) {
      deleteImageIfExists(post.image);
    }

    await Post.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Post silindi."
    });
  } catch (error) {
    console.log("Delete post hata:", error);
    res.status(500).json({
      success: false,
      message: "Post silinemedi."
    });
  }
});

/* =========================
   SOCKET
========================= */
io.on("connection", (socket) => {
  console.log("Bir kullanıcı bağlandı:", socket.id);

  socket.on("disconnect", () => {
    console.log("Bir kullanıcı ayrıldı:", socket.id);
  });
});

/* =========================
   DEFAULT ROUTE
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   SERVER
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server çalışıyor: http://localhost:${PORT}`);
});
