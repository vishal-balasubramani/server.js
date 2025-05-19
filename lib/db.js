const mongoose = require('mongoose');
const dotenv = require("dotenv").config();

const connectdb = async () =>{
    console.log('connecting to mongo db...')
    try{
        await mongoose.connect(process.env.MONGO_URL);
        console.log("mongodb connected.....");
    }
    catch(error){
        console.log('error occured while connecting to mongo db', error);
        process.exit(1);
    }
}
module.exports =  connectdb;

