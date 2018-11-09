var beginTime = new Date(2017, 1, 14, 20, 00, 00).getTime();

window.onload = function () {
    update();
    console.log(beginTime);
}

setInterval(
        "update()",
        1000
);

function update() {

    var curTime = new Date().getTime();
    console.log(curTime);
    var diffMillSecond = curTime - beginTime;
    var diffSecond = diffMillSecond / 1000 ;
    var diffMinute = diffSecond / 60 ;
    var diffHour = diffMinute / 60 ;
    var diffDay = diffHour / 24 ;

    var str = "<p>秒：" + diffSecond.toFixed(2) + "</p>"+
              "<p>分：" + diffMinute.toFixed(2) + "</p>"+
              "<p>时：" + diffHour.toFixed(2) + "</p>"+
              "<p>天：" + diffDay.toFixed(2) + "</p>";

    content.innerHTML = str;
}

