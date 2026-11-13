
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './mikro-orm.config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { WageringController } from './modules/wagering/http/wagering.controller';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [
    AppController,
    WageringController,
  ],
  providers: [
    AppService,
  ],
})
export class AppModule {}
