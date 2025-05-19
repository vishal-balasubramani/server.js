const express= require('express');
const app = express();
const jwt = require('jsonwebtoken');
const bcrypt= require('bcrypt');
const path=require('path');
const mongoose=require('mongoose');
const cors=require('cors');
const crypto=require('crypto');
const nodemailer=require('nodemailer');
const connectdb  = require('./lib/db.js');
const User = require('./model/opencv.model.js');
const { name } = require('ejs');
const session = require('express-session');
const flash = require('connect-flash');

app.set("view engine","ejs");
app.set("views",path.join(__dirname,"views"));
app.use(express.urlencoded({extended:true}));


// app.use(cors({
//   origin:'http://127.0.0.1:5500',
//     credentials: true
// }));

app.use(session({
  secret: 'yourSecretKey',
  resave: false,
  saveUninitialized: false
}));

app.use(flash())
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));


// mongoose.connect('mongodb://localhost:27017/');


// const userSchema= new mongoose.Schema({
//     name:String,
//     email:String,
//     password:String,
//     phonenumber:String,
//     resettoken:String,
//     resetexpiry:Date,
//     otp:String,
//     otpverify:Boolean,
//     otpexpiry:Date
// })

// const User= mongoose.model('User',userSchema);


//auth middleware
const accessjwt=(req,res,next)=>{
  const authHeaders= req.headers['authorization'];
  const token= authHeaders && authHeaders.split(' ')[1];
  
  if(!token){
    return res.status(401).json({error:'Token Not provided'})
  }

  jwt.verify(token,process.env.ACCESS_TOKEN_SECRET,(err,user)=>{
    if(err) {
      return res.status(400).json({error:'Token is invalid'});
    }
    else{
      req.user=user;
      next();
    }  
  })
}

connectdb();

app.get("/login", (req, res) => {
  const messeage = req.flash("messeage")[0]|| {};
  res.render("regist", {
    formType: 'login',
    activeTab: 'login',
    messeage,
  })
});

app.get("/profile", (req, res) => {
  const userdetails = req.flash("userInfo")[0];
  res.render("profile",{userdetails});
});

app.get("/signup",  (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
    res.render("regist", {
    formType: 'signup',
    activeTab: 'signup',
    messeage,
  });
});

app.get("/forget-password",(req,res)=>{
  const messeage = req.flash("messeage")[0] || {};
  res.render("forgotPassword",{messeage});
})

app.get("/resendotp",(req,res)=>{
  const messeage = req.flash("messeage")[0]||{};
  res.render("resendotp",{messeage});
})

// app.post("/signup",(req,res)=>{
  
//   const newdata = new User({
//     name: req.body.name,
//     email: req.body.email,
//     phonenumber: req.body.phonenumber,
//     password: req.body.password,
//     confirmpassword: req.body.confirmpassword,
//   });
  
//   try{
//     newdata.save();
//     res.redirect("OTP");
//   }
//   catch(err){
//     console.log(err);
//   }
// })
  
app.get("/OTP",(req,res)=>{
  const messeage = req.flash("messeage")[0]||{};
  res.render("OTP",{messeage});
  
})

//reset-html 

app.get('/reset-password', (req, res) => {
  const token = req.query.token;
  const messeage = req.flash("messeage")[0]||{};
  res.render('reset-password',{token,messeage});
 
});




//auth
app.post('/signup',async(req,res)=>{
  const name= req.body.name;
  const email=req.body.email;
  const phonenumber=req.body.phonenumber;
  const password=req.body.password;
  const confirmpassword=req.body.confirmpassword;

  if( await User.findOne({name:name})){
    req.flash("messeage",{notify:"user already exist", type:"danger",time:"redirect"});
    res.redirect("/signup");
  }
  
  else if(password===confirmpassword){
    const OTP= crypto.randomBytes(2).toString('hex');
    const otpexpiry= new Date(Date.now()+3600000);
    const otpverify=false;


    const transport= nodemailer.createTransport({
      service:'gmail',
      auth:{
        user:"amma09068@gmail.com",
        pass:"wuxs gvcb uexz goxv",
      }
    })
    
    await transport.sendMail({
      to:email,
      subject:'OTP',
      html:`<h3>OTP:${OTP}</h3>`
    })
    const hashedpassword=await bcrypt.hash(password,10);
    const user={name:name,email:email,phonenumber:phonenumber,password:hashedpassword,otp:OTP}
    const newuser= new User(user);
    await newuser.save();
    res.redirect("/OTP");
    
   
  }
  else{
    req.flash("messeage",{notify:"Password does not match", type:"danger"});
    res.redirect("/signup");
  }

})

//auth
app.post('/login',async(req,res)=>{
  const email=req.body.email;
  const password=req.body.password;
  const user=await User.findOne({email:email});
  if(!user){
    req.flash("messeage",{notify:"user not found", type:"danger"});
    return res.redirect("/login");
  }
  else{
    const isMatch=await bcrypt.compare(password,user.password);
    if(!isMatch){
      req.flash("messeage",{notify:"Invalid Password", type:"danger"});
      res.redirect("/login");
    }
    else{
      
      req.flash("userInfo",{name:user.name,email:user.email,phonenumber:user.phonenumber});
      return res.redirect("/profile");
      
      
  }
  }
})


//forget-password
app.post('/forget-password',async(req,res)=>{
  const email=req.body.email;
  const user=await User.findOne({email:email});
  if(!user){
    req.flash("messeage",{notify:"user not found", type:"danger"});
    return res.redirect("/forget-password");
  }
  const token = crypto.randomBytes(32).toString('hex');
    console.log('send token',token);
    user.resetexpiry = new Date(Date.now() + 3600000);

    user.resettoken=token;
  await user.save();
  
  const transporter=nodemailer.createTransport({
    service:'gmail',
    auth:{
      user:"amma09068"+"@gmail.com",
      pass:"wuxs gvcb uexz goxv",
      
    }
  })

  const resetlink=`http://localhost:3000/reset-password?token=${token}`;
  console.log(resetlink);
  await transporter.sendMail({
    to:email,
    subject:'Reset Password',
    html: `<h1>Click here to reset your password: <a href="${resetlink}">Reset Password</a></h1>`

    
  });
  req.flash("messeage",{notify:"reset password link sent in mail successfully", type:"success"});
  return res.redirect("/forget-password");

  
})

//reset-final
app.post('/reset-password',async(req,res)=>{
  const password=req.body.password;
  const confirmpassword=req.body.confirmPassword;
  const token=req.body.token;

    if(password == confirmpassword){
      
      const user=await User.findOne({resettoken:token,resetexpiry:{$gt:Date.now()}});
      
      if(!user){
        req.flash("messeage",{notify:"user not found", type:"danger"});
        return res.redirect("/reset-password");
      }
      else if(user){
      const password= req.body.password;
      const hashedpassword= await bcrypt.hash(password,10);
      user.password=hashedpassword;
      await user.save();
      console.log('password updated successfully');
        res.redirect("/login");
      }
         
  }
 
})

app.post('/OTP',async(req,res)=>{
  const otp=req.body.otp;
  const user= await User.findOne({otp:otp});

  if(!user){
    req.flash("messeage",{notify:"Incorrect otp", type:"danger"});
    return res.redirect("/OTP");
  }

  else{
    user.otpverify=true;
    user.otpexpiry=null;
    user.otp='';
     await user.save();
     console.log('otp verified successful');
    req.flash("userInfo",{email:user.email,name:user.name,phonenumber:user.phonenumber});
    return res.redirect("/profile");

   
  }
})


app.post('/resendotp',async(req,res)=>{
  const email= req.body.email;
  
  const user=await User.findOne({email:email});
  if(!user){
    req.flash("messeage",{notify:"user not found", type:"danger"});
    return res.redirect("/resendotp");
  }
  else{
    const OTP= crypto.randomBytes(2).toString('hex');
    const otpexpiry= new Date(Date.now()+3600000);
    


    const transport= nodemailer.createTransport({
      service:'gmail',
      auth:{
        user:"amma09068@gmail.com",
        pass:"wuxs gvcb uexz goxv",
      }
    })
    
    await transport.sendMail({
      to:email,
      subject:'OTP',
      html:`<h3>OTP:${OTP}</h3>`
    })
    user.otp=OTP;
    user.otpexpiry=otpexpiry;
    await user.save();
    return res.redirect("/OTP");

  }
})

app.listen(3000,()=>{
    console.log(`server is running on http://localhost:3000`);
})